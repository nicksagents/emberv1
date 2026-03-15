import { readSettings } from "@ember/core";

import type { EmberTool } from "./types.js";

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  extraSnippets?: string[];
}

interface FetchedPage {
  url: string;
  title: string;
  extract: string;
  fetchError?: string;
}

// ── Brave Search API ────────────────────────────────────────────────────────

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
  page_age?: string;
  language?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
  query?: {
    original?: string;
    altered?: string;
  };
  mixed?: {
    main?: Array<{ type: string; index: number }>;
  };
}

async function fetchBraveResults(
  query: string,
  maxResults: number,
  apiKey: string,
  freshness?: string,
): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(maxResults, 20)));
  url.searchParams.set("result_filter", "web");
  url.searchParams.set("text_decorations", "false");
  if (freshness) {
    url.searchParams.set("freshness", freshness);
  }

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
    extraSnippets: r.extra_snippets,
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncateSnippet(text: string, max = 350): string {
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

// ── Auto-fetch: extract focused content from top results ─────────────────

/** Lightweight HTML-to-text for auto-fetched pages (mirrors fetch-page logic). */
function htmlToText(html: string): string {
  return html
    // Drop script/style/svg/noscript/nav/header/footer blocks
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
    // Headings → newline + text
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _lvl, inner) =>
      "\n\n" + inner.replace(/<[^>]+>/g, "").trim() + "\n",
    )
    // Block elements → newlines
    .replace(
      /<\/?(p|div|li|tr|blockquote|pre|article|section|main|aside|figure|figcaption|table|thead|tbody|tfoot|dd|dt)[^>]*>/gi,
      "\n",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    // Links: keep visible text
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

/** Chars budget per page — enough context to answer most questions. */
const AUTO_FETCH_CHARS_PER_PAGE = 6_000;

async function autoFetchPage(url: string): Promise<FetchedPage> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      return { url, title: "", extract: "", fetchError: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (
      !contentType.includes("html") &&
      !contentType.includes("text") &&
      !contentType.includes("json")
    ) {
      return { url, title: "", extract: "", fetchError: `Unreadable content-type: ${contentType}` };
    }

    const body = await res.text();
    let title = "";
    let text: string;

    if (contentType.includes("html")) {
      title = extractTitle(body);
      text = htmlToText(body);
    } else if (contentType.includes("json")) {
      try {
        text = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        text = body;
      }
    } else {
      text = body;
    }

    // Take focused extract — skip leading whitespace-only lines
    const trimmed = text.replace(/^\s*\n/, "");
    const extract = trimmed.slice(0, AUTO_FETCH_CHARS_PER_PAGE).replace(/\s+\S*$/, "");

    return { url, title, extract };
  } catch (err) {
    return {
      url,
      title: "",
      extract: "",
      fetchError: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Format output ───────────────────────────────────────────────────────────

function formatResultsOnly(results: SearchResult[], site: string): string {
  const items = results
    .map((r, i) => {
      const snippetLines: string[] = [];
      if (r.snippet) snippetLines.push(truncateSnippet(r.snippet));
      // Include extra snippets from Brave for more context
      if (r.extraSnippets) {
        for (const extra of r.extraSnippets.slice(0, 2)) {
          const trimmed = truncateSnippet(extra, 250);
          if (trimmed && trimmed !== r.snippet) snippetLines.push(trimmed);
        }
      }
      const snippetBlock = snippetLines.length
        ? "\n" + snippetLines.map((s) => `   ${s}`).join("\n")
        : "";
      return `${i + 1}. ${r.title}${snippetBlock}\n   ${r.url}`;
    })
    .join("\n\n");
  return `Web results${site ? ` (site:${site})` : ""}:\n\n${items}`;
}

function formatResultsWithContent(
  results: SearchResult[],
  pages: FetchedPage[],
  site: string,
): string {
  const pageMap = new Map<string, FetchedPage>();
  for (const p of pages) pageMap.set(p.url, p);

  const sections: string[] = [];

  // Summary list of all results
  const summary = results
    .map((r, i) => {
      const fetched = pageMap.has(r.url);
      const marker = fetched ? " [content below]" : "";
      return `${i + 1}. ${r.title}${marker}\n   ${r.url}`;
    })
    .join("\n");
  sections.push(`Search results${site ? ` (site:${site})` : ""}:\n\n${summary}`);

  // Full content for auto-fetched pages
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const page = pageMap.get(result.url);
    if (!page) continue;

    if (page.fetchError) {
      sections.push(
        `── Result ${i + 1}: ${result.title} ──\nURL: ${result.url}\nFetch error: ${page.fetchError}\nSnippet: ${result.snippet}`,
      );
      continue;
    }

    if (!page.extract) continue;

    const header = page.title && page.title !== result.title
      ? `── Result ${i + 1}: ${result.title} ──\nPage title: ${page.title}\nURL: ${result.url}`
      : `── Result ${i + 1}: ${result.title} ──\nURL: ${result.url}`;

    sections.push(`${header}\n\n${page.extract}`);
  }

  // List remaining results that weren't fetched (with snippets)
  const unfetched = results.filter((r) => !pageMap.has(r.url));
  if (unfetched.length > 0) {
    const list = unfetched
      .map((r) => {
        const snippet = r.snippet ? `\n   ${truncateSnippet(r.snippet)}` : "";
        return `• ${r.title}${snippet}\n  ${r.url}`;
      })
      .join("\n\n");
    sections.push(`── Other results (not fetched) ──\n\n${list}`);
  }

  return sections.join("\n\n");
}

// ── Main execute ────────────────────────────────────────────────────────────

async function execute(input: Record<string, unknown>): Promise<string> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const maxResults = typeof input.max_results === "number" ? Math.min(input.max_results, 10) : 5;
  const site = typeof input.site === "string" ? normalizeDomain(input.site) : "";
  const region =
    typeof input.region === "string" && input.region.trim() ? input.region.trim() : "us-en";
  const freshness =
    typeof input.freshness === "string" && input.freshness.trim() ? input.freshness.trim() : undefined;

  // auto_fetch defaults to true — fetch page content for the top results automatically
  const autoFetchCount = (() => {
    if (input.auto_fetch === false) return 0;
    if (typeof input.auto_fetch === "number") return Math.min(Math.max(0, Math.floor(input.auto_fetch)), 5);
    // Default: fetch top 3 results
    return 3;
  })();

  if (!query) return "Error: no query provided.";

  const effectiveQuery = site ? `${query} site:${site}` : query;

  // Check for Brave API key in settings
  const settings = await readSettings();
  const braveApiKey = settings.braveApiKey?.trim() ?? "";

  let results: SearchResult[] = [];
  let instantAnswer: string | null = null;

  if (braveApiKey) {
    // ── Brave Search ──────────────────────────────────────────────────────
    console.log(`[tool:web_search] Brave "${effectiveQuery}" (max ${maxResults}, fetch ${autoFetchCount})`);
    try {
      results = await fetchBraveResults(effectiveQuery, maxResults, braveApiKey, freshness);
    } catch (err) {
      console.warn(`[tool:web_search] Brave API failed, falling back to DDG: ${err}`);
    }
  }

  if (results.length === 0) {
    // ── DuckDuckGo fallback ─────────────────────────────────────────────
    console.log(`[tool:web_search] DDG "${effectiveQuery}" (max ${maxResults}, region ${region})`);

    const [instant, webResults] = await Promise.allSettled([
      fetchDdgInstantAnswer(effectiveQuery),
      fetchDdgResults(effectiveQuery, maxResults, region),
    ]);

    if (instant.status === "fulfilled" && instant.value) {
      instantAnswer = instant.value;
    }

    if (webResults.status === "fulfilled") {
      results = webResults.value;
    } else {
      console.warn(`[tool:web_search] DDG HTML fetch failed: ${webResults.reason}`);
    }
  }

  if (results.length === 0 && !instantAnswer) {
    return `No results found for "${query}". Try rephrasing or breaking the query into simpler terms.`;
  }

  // ── Auto-fetch top results in parallel ──────────────────────────────────
  const fetchCount = Math.min(autoFetchCount, results.length);
  let fetchedPages: FetchedPage[] = [];

  if (fetchCount > 0) {
    const urlsToFetch = results.slice(0, fetchCount).map((r) => r.url);
    console.log(`[tool:web_search] Auto-fetching ${urlsToFetch.length} pages...`);
    fetchedPages = await Promise.all(urlsToFetch.map(autoFetchPage));
    // Filter out pages that completely failed (no content at all)
    fetchedPages = fetchedPages.filter((p) => p.extract || p.fetchError);
  }

  // ── Build output ────────────────────────────────────────────────────────
  const sections: string[] = [];

  if (instantAnswer) {
    sections.push(instantAnswer);
  }

  if (fetchedPages.length > 0) {
    sections.push(formatResultsWithContent(results, fetchedPages, site));
  } else {
    sections.push(formatResultsOnly(results, site));
  }

  return sections.join("\n\n---\n\n");
}

export const webSearchTool: EmberTool = {
  definition: {
    name: "web_search",
    description:
      "Search the web and automatically fetch page content from top results. " +
      "Returns search results with full extracted text from the top 3 pages by default, " +
      "so you usually don't need to call fetch_page separately. " +
      "Use auto_fetch=false if you only need a quick list of links, or auto_fetch=5 to read more pages. " +
      "Use freshness for time-sensitive queries (e.g. 'pd' for past day, 'pw' for past week).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search keywords. Use specific terms, not full sentences. " +
            "Add context terms to narrow results (e.g. 'react useEffect cleanup memory leak' not 'how to fix memory leaks').",
        },
        max_results: {
          type: "number",
          description: "Number of search results to return. Default 5, max 10.",
        },
        auto_fetch: {
          type: "number",
          description:
            "How many top results to auto-fetch full page content for. " +
            "Default 3. Set to 0 to skip fetching (returns only titles/snippets). " +
            "Set to 5 for thorough research. Each page adds ~6k chars to the response.",
        },
        site: {
          type: "string",
          description: "Limit results to this domain, e.g. 'github.com' or 'stackoverflow.com'.",
        },
        freshness: {
          type: "string",
          description:
            "Time filter (Brave API only). Values: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year), or a date range 'YYYY-MM-DDtoYYYY-MM-DD'.",
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
