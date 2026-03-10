import type { EmberTool } from "./types.js";

const MAX_BODY_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function parseJsonObject(value: string, label: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      output[key] = String(item);
      continue;
    }
    throw new Error(`${label} values must be strings, numbers, or booleans.`);
  }
  return output;
}

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}\n\n[truncated at ${MAX_BODY_CHARS} chars]`
    : text;
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const method = typeof input.method === "string" ? input.method.trim().toUpperCase() : "GET";
  const body = typeof input.body === "string" ? input.body : "";
  const jsonBody =
    typeof input.json_body === "string" && input.json_body.trim()
      ? input.json_body.trim()
      : typeof input.json === "string"
        ? input.json.trim()
        : "";
  const headersJson = typeof input.headers_json === "string" ? input.headers_json.trim() : "";
  const timeoutMs =
    typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
      ? clamp(Math.floor(input.timeout_ms), 1_000, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  const includeHeaders = input.include_headers !== false;

  if (!url) {
    return "Error: url is required.";
  }
  if (!/^https?:\/\//i.test(url)) {
    return "Error: URL must start with http:// or https://.";
  }

  let headers: Record<string, string> = {};
  if (headersJson) {
    try {
      const parsed = parseJsonObject(headersJson, "headers_json");
      if (!parsed) {
        return "Error: headers_json must be a valid JSON object.";
      }
      headers = parsed;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  let requestBody: string | undefined;
  if (jsonBody) {
    try {
      requestBody = JSON.stringify(JSON.parse(jsonBody));
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
    } catch {
      return "Error: json_body must be valid JSON.";
    }
  } else if (body) {
    requestBody = body;
  }

  console.log(`[tool:http_request] ${method} ${url}`);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") ?? "";
    const finalUrl = response.url || url;
    let responseBody = await response.text();

    if (contentType.includes("application/json")) {
      try {
        responseBody = JSON.stringify(JSON.parse(responseBody), null, 2);
      } catch {
        // Keep raw response if the server mislabeled the payload.
      }
    }

    const headerLines = includeHeaders
      ? [...response.headers.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n")
      : "";

    return [
      `Status: ${response.status} ${response.statusText}`,
      `URL: ${finalUrl}`,
      `Content-Type: ${contentType || "unknown"}`,
      includeHeaders ? `Headers:\n${headerLines || "(no headers)"}` : "",
      "",
      truncate(responseBody || "(empty body)"),
    ]
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    return `Error performing HTTP request: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const httpRequestTool: EmberTool = {
  definition: {
    name: "http_request",
    description:
      "Make a direct HTTP request and return the response status, headers, and body. " +
      "Use this for APIs, health checks, JSON endpoints, webhook debugging, and backend verification when browser automation is unnecessary.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL to request, starting with http:// or https://.",
        },
        method: {
          type: "string",
          description: "HTTP method such as GET, POST, PUT, PATCH, DELETE, or HEAD. Default GET.",
        },
        headers_json: {
          type: "string",
          description: "Optional JSON object string for request headers.",
        },
        body: {
          type: "string",
          description: "Optional raw request body for non-JSON payloads.",
        },
        json_body: {
          type: "string",
          description: "Optional JSON string to send as the request body. Sets content-type to application/json if not already provided.",
        },
        json: {
          type: "string",
          description: "Alias for json_body.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds. Default 30000, maximum 120000.",
        },
        include_headers: {
          type: "boolean",
          description: "Set to false to omit response headers from the result.",
        },
      },
      required: ["url"],
    },
  },
  systemPrompt:
    "http_request — For APIs use this before browser. GET with url is the default; use json for JSON POST bodies.",
  execute,
};
