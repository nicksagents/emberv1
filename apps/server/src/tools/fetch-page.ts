import type { EmberTool } from "./types.js";

const PAGE_SIZE = 100_000;
const LINK_LIMIT = 40;

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

function decodeEntities(text: string): string {
  return text
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
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      // Drop script/style/svg/noscript blocks entirely
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
      // Headings → newline + text
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, _lvl, inner) =>
        "\n\n" + inner.replace(/<[^>]+>/g, "").trim() + "\n",
      )
      // Block elements → newlines
      .replace(
        /<\/?(p|div|li|tr|blockquote|pre|article|section|header|footer|nav|main|aside|figure|figcaption|table|thead|tbody|tfoot)[^>]*>/gi,
        "\n",
      )
      .replace(/<br\s*\/?>/gi, "\n")
      // Links: keep visible text
      .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Collapse whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function extractLinks(html: string, baseUrl: string): string[] {
  const rawMatches = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const seen = new Set<string>();
  const results: string[] = [];

  for (const match of rawMatches) {
    if (results.length >= LINK_LIMIT) {
      break;
    }

    const href = match[1]?.trim() ?? "";
    const text = decodeEntities((match[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!href) {
      continue;
    }

    let resolved = href;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      resolved = href;
    }

    const key = `${resolved}|${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(text ? `${text}\n  ${resolved}` : resolved);
  }

  return results;
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) return "Error: no URL provided.";
  if (!/^https?:\/\//i.test(url)) return "Error: URL must start with http:// or https://.";

  const offset = typeof input.offset === "number" ? Math.max(0, Math.floor(input.offset)) : 0;
  const includeLinks = input.include_links === true;

  console.log(`[tool:fetch_page] "${url}" offset=${offset}${includeLinks ? " (include_links)" : ""}`);

  let rawText: string;
  let title = "";
  let pageLinks: string[] = [];
  let finalUrl = url;
  let contentType = "";

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      return `Error: ${response.status} ${response.statusText} from ${url}`;
    }

    finalUrl = response.url || url;
    contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/pdf")) {
      return (
        `Error: "${url}" returned a PDF file. This tool cannot extract text from binary PDFs.\n` +
        `Suggestions:\n` +
        `  • Search for an HTML version of the document (add "site:documentcloud.org" or "filetype:html" to your search)\n` +
        `  • Try archive.org: https://web.archive.org/web/*/${url}\n` +
        `  • Look for a page that embeds or summarizes the PDF content.`
      );
    }

    if (
      !contentType.includes("html") &&
      !contentType.includes("text") &&
      !contentType.includes("xml") &&
      !contentType.includes("json")
    ) {
      return `Error: content type "${contentType}" is not readable — this tool reads HTML, plain text, XML, and JSON pages.`;
    }

    const body = await response.text();

    if (contentType.includes("html")) {
      title = extractTitle(body);
      if (includeLinks) {
        pageLinks = extractLinks(body, finalUrl);
      }
      rawText = htmlToText(body);
    } else if (contentType.includes("json")) {
      try {
        rawText = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        rawText = decodeEntities(body);
      }
    } else {
      // plain text / xml / json — return as-is (decoded if needed)
      rawText = decodeEntities(body);
    }
  } catch (err) {
    return `Error fetching page: ${err instanceof Error ? err.message : String(err)}`;
  }

  const totalChars = rawText.length;
  const slice = rawText.slice(offset, offset + PAGE_SIZE);

  const hasMore = offset + PAGE_SIZE < totalChars;
  const nextOffset = offset + PAGE_SIZE;

  const header = [
    title ? `Title: ${title}` : null,
    `URL: ${finalUrl}`,
    `Content-Type: ${contentType || "unknown"}`,
    `Characters: ${offset + 1}–${Math.min(offset + slice.length, totalChars)} of ${totalChars}`,
    hasMore
      ? `\nThis page has more content. Call fetch_page again with offset=${nextOffset} to continue reading.`
      : null,
    "",
  ]
    .filter((x) => x !== null)
    .join("\n");

  const linksSection =
    includeLinks && pageLinks.length
      ? `\n\nLinks:\n${pageLinks.join("\n\n")}${pageLinks.length >= LINK_LIMIT ? "\n\n[truncated link list]" : ""}`
      : "";

  return header + "\n" + slice + linksSection;
}

export const fetchPageTool: EmberTool = {
  definition: {
    name: "fetch_page",
    description:
      "Fetch a public web page or document by URL and return its text content. " +
      "Returns up to 100,000 characters per call. For long documents, use the offset parameter " +
      "to read subsequent pages (e.g. offset=100000 for the second page). " +
      "Use this after web_search to read the complete content of a result, " +
      "or to retrieve documentation, articles, GitHub READMEs, government documents, or any public URL. " +
      "Does not support binary PDFs — look for HTML versions of PDFs when needed.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full URL to fetch (must start with http:// or https://).",
        },
        offset: {
          type: "number",
          description:
            "Character offset to start reading from (default 0). " +
            "Use the value from 'Call fetch_page again with offset=N' to read the next page of a long document.",
        },
        include_links: {
          type: "boolean",
          description: "Set to true to append a deduplicated link list from the page.",
        },
      },
      required: ["url"],
    },
  },
  execute,
};
