import { readSettings } from "@ember/core";

import type { EmberTool } from "./types.js";

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

// ── Brave Search API ────────────────────────────────────────────────────────

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
  query?: {
    original?: string;
  };
}

async function fetchBraveResults(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(maxResults, 20)));
  url.searchParams.set("result_filter", "web");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Brave Search API returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const raw = data.web?.results ?? [];

  return raw.slice(0, maxResults).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? r.extra_snippets?.[0] ?? "",
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncateSnippet(text: string, max = 180): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// ── DuckDuckGo fallback ─────────────────────────────────────────────────────

interface InstantAnswer {
  Answer?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
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

  const titleRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ url: string; text: string }> = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;

  while ((m = titleRegex.exec(html)) !== null && titles.length < maxResults * 2) {
    const href = m[1] ?? "";
    const text = stripHtml(m[2] ?? "");
    if (!text) continue;

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

async function fetchDdgInstantAnswer(query: string): Promise<string | null> {
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

async function fetchDdgResults(
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
  return parseDdgHtml(html, maxResults * 2)
    .filter((result) => {
      const key = normalizeDomain(result.url) + "|" + result.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxResults);
}

// ── Main execute ────────────────────────────────────────────────────────────

async function execute(input: Record<string, unknown>): Promise<string> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const maxResults = typeof input.max_results === "number" ? Math.min(input.max_results, 10) : 6;
  const site = typeof input.site === "string" ? normalizeDomain(input.site) : "";
  const region =
    typeof input.region === "string" && input.region.trim() ? input.region.trim() : "us-en";

  if (!query) return "Error: no query provided.";

  const effectiveQuery = site ? `${query} site:${site}` : query;

  // Check for Brave API key in settings
  const settings = await readSettings();
  const braveApiKey = settings.braveApiKey?.trim() ?? "";

  if (braveApiKey) {
    // ── Brave Search ──────────────────────────────────────────────────────
    console.log(`[tool:web_search] Brave "${effectiveQuery}" (max ${maxResults})`);
    try {
      const results = await fetchBraveResults(effectiveQuery, maxResults, braveApiKey);
      if (results.length === 0) {
        return `No results found for "${query}". Try rephrasing or breaking the query into simpler terms.`;
      }
      const items = results
        .map((r, i) => {
          const snippet = r.snippet ? `\n   ${truncateSnippet(r.snippet)}` : "";
          return `${i + 1}. ${r.title}${snippet}\n   ${r.url}`;
        })
        .join("\n\n");
      return `Web results${site ? ` (site:${site})` : ""}:\n\n${items}`;
    } catch (err) {
      console.warn(`[tool:web_search] Brave API failed, falling back to DDG: ${err}`);
      // fall through to DDG below
    }
  }

  // ── DuckDuckGo fallback ─────────────────────────────────────────────────
  console.log(`[tool:web_search] DDG "${effectiveQuery}" (max ${maxResults}, region ${region})`);

  const [instant, webResults] = await Promise.allSettled([
    fetchDdgInstantAnswer(effectiveQuery),
    fetchDdgResults(effectiveQuery, maxResults, region),
  ]);

  const sections: string[] = [];

  if (instant.status === "fulfilled" && instant.value) {
    sections.push(instant.value);
  }

  if (webResults.status === "fulfilled" && webResults.value.length > 0) {
    const items = webResults.value
      .map((r, i) => {
        const snippet = r.snippet ? `\n   ${truncateSnippet(r.snippet)}` : "";
        return `${i + 1}. ${r.title}${snippet}\n   ${r.url}`;
      })
      .join("\n\n");
    sections.push(`Web results${site ? ` (site:${site})` : ""}:\n\n${items}`);
  } else if (webResults.status === "rejected") {
    console.warn(`[tool:web_search] DDG HTML fetch failed: ${webResults.reason}`);
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
      "Search the web for current information, documentation, news, or packages. " +
      "Returns titles, snippets, and URLs. Always follow up with fetch_page to read the full content.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keywords. Specific terms work better than full sentences.",
        },
        max_results: {
          type: "number",
          description: "Number of results to return. Default 6, max 10.",
        },
        site: {
          type: "string",
          description: "Limit results to this domain, e.g. 'github.com'.",
        },
        region: {
          type: "string",
          description: "Region code, e.g. 'us-en'. Only applies when Brave API is not configured.",
        },
      },
      required: ["query"],
    },
  },
  execute,
};
