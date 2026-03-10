import type { EmberTool } from "./types.js";

interface InstantAnswer {
  Answer?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
}

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseDdgHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Extract title links — DDG wraps them in <a class="result__a" href="...">
  const titleRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  // Extract snippets — DDG wraps them in <a class="result__snippet" ...>
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ url: string; text: string }> = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;

  while ((m = titleRegex.exec(html)) !== null && titles.length < maxResults * 2) {
    const href = m[1] ?? "";
    const text = stripHtml(m[2] ?? "");
    if (!text) continue;

    // DDG redirects via /l/?uddg=ENCODED_REAL_URL&...
    let url = href;
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        url = href;
      }
    } else if (href.startsWith("/")) {
      url = `https://duckduckgo.com${href}`;
    }

    // Skip DDG-internal and ad links
    if (url.includes("duckduckgo.com") && !url.includes("uddg=")) continue;

    titles.push({ url, text });
  }

  while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults * 2) {
    snippets.push(stripHtml(m[1] ?? ""));
  }

  for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
    results.push({
      title: titles[i].text,
      snippet: snippets[i] ?? "",
      url: titles[i].url,
    });
  }

  return results;
}

async function fetchInstantAnswer(query: string): Promise<string | null> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Ember/1.0 (local AI assistant)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as InstantAnswer;

    if (data.Answer) return `Instant answer: ${data.Answer}`;
    if (data.AbstractText) {
      const src = data.AbstractSource ? ` (${data.AbstractSource})` : "";
      const link = data.AbstractURL ? `\n${data.AbstractURL}` : "";
      return `Summary${src}: ${data.AbstractText}${link}`;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchWebResults(
  query: string,
  maxResults: number,
  region: string,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${encodeURIComponent(region)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DDG HTML search returned ${res.status}`);
  const html = await res.text();
  const seen = new Set<string>();
  return parseDdgHtml(html, maxResults * 2).filter((result) => {
    const key = normalizeDomain(result.url) + "|" + result.title.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, maxResults);
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const maxResults = typeof input.max_results === "number" ? Math.min(input.max_results, 10) : 6;
  const site = typeof input.site === "string" ? normalizeDomain(input.site) : "";
  const region = typeof input.region === "string" && input.region.trim() ? input.region.trim() : "us-en";
  if (!query) return "Error: no query provided.";

  const effectiveQuery = site ? `${query} site:${site}` : query;

  console.log(`[tool:web_search] "${effectiveQuery}" (max ${maxResults}, region ${region})`);

  // Fire both requests concurrently
  const [instant, webResults] = await Promise.allSettled([
    fetchInstantAnswer(effectiveQuery),
    fetchWebResults(effectiveQuery, maxResults, region),
  ]);

  const sections: string[] = [];

  if (instant.status === "fulfilled" && instant.value) {
    sections.push(instant.value);
  }

  if (webResults.status === "fulfilled" && webResults.value.length > 0) {
    const items = webResults.value
      .map((r, i) => {
        const snippet = r.snippet ? `\n   ${r.snippet}` : "";
        return `${i + 1}. ${r.title}${snippet}\n   ${r.url}`;
      })
      .join("\n\n");
    sections.push(`Web results${site ? ` (site:${site})` : ""}:\n\n${items}`);
  } else if (webResults.status === "rejected") {
    console.warn(`[tool:web_search] HTML fetch failed: ${webResults.reason}`);
  }

  if (!sections.length) {
    return `No results found for "${query}". Try rephrasing or breaking the query into simpler terms.`;
  }

  return sections.join("\n\n---\n\n");
}

export const webSearchTool: EmberTool = {
  definition: {
    name: "web_search",
    description:
      "Search the web using DuckDuckGo and return real web results (title, snippet, URL) plus instant answers. " +
      "Use this to find current information, documentation, news, packages, or anything you are unsure about. " +
      "After getting results, use fetch_page to read the full content of the most relevant URL.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query. Be specific — use keywords, not questions.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of web results to return (default 6, max 10).",
        },
        site: {
          type: "string",
          description: "Optional domain filter such as 'docs.openai.com' or 'github.com'.",
        },
        region: {
          type: "string",
          description: "Optional DuckDuckGo region code such as 'us-en' or 'ca-en'. Default us-en.",
        },
      },
      required: ["query"],
    },
  },
  execute,
};
