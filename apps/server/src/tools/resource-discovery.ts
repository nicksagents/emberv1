/**
 * Resource Discovery Tool
 *
 * Curated registry of free web services and APIs the agent can use autonomously.
 * When the registry doesn't cover a need, falls back to web search suggestions.
 */

import type { EmberTool } from "./types.js";

// ─── Resource Registry ──────────────────────────────────────────────────────────

interface ResourceEntry {
  name: string;
  url: string;
  category: string;
  description: string;
  requiresSignup: boolean;
  apiEndpoint: string | null;
  authMethod: "none" | "api-key" | "email-signup" | "oauth";
  freeLimit: string;
  tags: string[];
}

const VALID_CATEGORIES = [
  "email",
  "file-conversion",
  "image",
  "text",
  "code",
  "data",
  "communication",
  "storage",
  "ai",
  "utilities",
  "other",
] as const;

const RESOURCE_REGISTRY: ResourceEntry[] = [
  // ── Email ──
  {
    name: "Mail.tm",
    url: "https://mail.tm",
    category: "email",
    description: "Disposable email with full API. Create temporary inboxes for signups and verifications.",
    requiresSignup: false,
    apiEndpoint: "https://api.mail.tm",
    authMethod: "none",
    freeLimit: "Unlimited temporary addresses",
    tags: ["temp-email", "disposable", "verification", "signup"],
  },
  {
    name: "1secmail",
    url: "https://www.1secmail.com",
    category: "email",
    description: "Simple disposable email API. Generate addresses and check inboxes via REST.",
    requiresSignup: false,
    apiEndpoint: "https://www.1secmail.com/api/v1/",
    authMethod: "none",
    freeLimit: "Unlimited",
    tags: ["temp-email", "disposable", "api"],
  },
  {
    name: "Guerrilla Mail",
    url: "https://www.guerrillamail.com",
    category: "email",
    description: "Disposable email service with API access.",
    requiresSignup: false,
    apiEndpoint: "https://api.guerrillamail.com/ajax.php",
    authMethod: "none",
    freeLimit: "Unlimited",
    tags: ["temp-email", "disposable"],
  },

  // ── File Conversion ──
  {
    name: "CloudConvert",
    url: "https://cloudconvert.com",
    category: "file-conversion",
    description: "Convert between 200+ file formats. PDF, DOCX, images, audio, video.",
    requiresSignup: true,
    apiEndpoint: "https://api.cloudconvert.com/v2",
    authMethod: "api-key",
    freeLimit: "25 conversions/day free",
    tags: ["convert", "pdf", "docx", "image", "audio", "video"],
  },
  {
    name: "Convertio",
    url: "https://convertio.co",
    category: "file-conversion",
    description: "File converter supporting 300+ formats via API.",
    requiresSignup: true,
    apiEndpoint: "https://api.convertio.co/convert",
    authMethod: "api-key",
    freeLimit: "10 minutes/day free",
    tags: ["convert", "pdf", "format"],
  },

  // ── Image ──
  {
    name: "Remove.bg",
    url: "https://www.remove.bg",
    category: "image",
    description: "Remove image backgrounds automatically via API.",
    requiresSignup: true,
    apiEndpoint: "https://api.remove.bg/v1.0/removebg",
    authMethod: "api-key",
    freeLimit: "50 free API calls/month",
    tags: ["image", "background-removal", "edit"],
  },
  {
    name: "TinyPNG",
    url: "https://tinypng.com",
    category: "image",
    description: "Compress and resize PNG/JPEG images via API.",
    requiresSignup: true,
    apiEndpoint: "https://api.tinify.com/shrink",
    authMethod: "api-key",
    freeLimit: "500 compressions/month free",
    tags: ["image", "compress", "resize", "optimize"],
  },
  {
    name: "Placeholder.com",
    url: "https://placeholder.com",
    category: "image",
    description: "Generate placeholder images of any size. No API key needed.",
    requiresSignup: false,
    apiEndpoint: "https://via.placeholder.com/{width}x{height}",
    authMethod: "none",
    freeLimit: "Unlimited",
    tags: ["image", "placeholder", "generate"],
  },

  // ── Text / NLP ──
  {
    name: "LibreTranslate",
    url: "https://libretranslate.com",
    category: "text",
    description: "Free open-source machine translation API.",
    requiresSignup: false,
    apiEndpoint: "https://libretranslate.com/translate",
    authMethod: "none",
    freeLimit: "Rate-limited, self-host for unlimited",
    tags: ["translate", "language", "nlp"],
  },
  {
    name: "LanguageTool",
    url: "https://languagetool.org",
    category: "text",
    description: "Grammar and spell checking API. Supports 30+ languages.",
    requiresSignup: false,
    apiEndpoint: "https://api.languagetool.org/v2/check",
    authMethod: "none",
    freeLimit: "20 requests/minute free",
    tags: ["grammar", "spelling", "proofread", "nlp"],
  },

  // ── Code ──
  {
    name: "Piston",
    url: "https://github.com/engineer-man/piston",
    category: "code",
    description: "Execute code in 50+ languages via REST API. No signup needed.",
    requiresSignup: false,
    apiEndpoint: "https://emkc.org/api/v2/piston/execute",
    authMethod: "none",
    freeLimit: "Rate-limited public API",
    tags: ["code-execution", "sandbox", "run-code", "compile"],
  },
  {
    name: "Prettier (npm)",
    url: "https://prettier.io",
    category: "code",
    description: "Code formatter for JS/TS/CSS/HTML/JSON/etc. Use via terminal: npx prettier.",
    requiresSignup: false,
    apiEndpoint: null,
    authMethod: "none",
    freeLimit: "Unlimited (local tool)",
    tags: ["format", "code", "prettier", "lint"],
  },

  // ── Data ──
  {
    name: "JSONPlaceholder",
    url: "https://jsonplaceholder.typicode.com",
    category: "data",
    description: "Fake REST API for testing and prototyping.",
    requiresSignup: false,
    apiEndpoint: "https://jsonplaceholder.typicode.com",
    authMethod: "none",
    freeLimit: "Unlimited",
    tags: ["mock", "api", "testing", "fake-data"],
  },
  {
    name: "Open-Meteo",
    url: "https://open-meteo.com",
    category: "data",
    description: "Free weather API. Current, forecast, and historical weather data.",
    requiresSignup: false,
    apiEndpoint: "https://api.open-meteo.com/v1/forecast",
    authMethod: "none",
    freeLimit: "10,000 requests/day free",
    tags: ["weather", "forecast", "climate", "data"],
  },
  {
    name: "REST Countries",
    url: "https://restcountries.com",
    category: "data",
    description: "Country data API: population, languages, currencies, borders, etc.",
    requiresSignup: false,
    apiEndpoint: "https://restcountries.com/v3.1",
    authMethod: "none",
    freeLimit: "Unlimited",
    tags: ["countries", "geography", "data"],
  },
  {
    name: "ExchangeRate-API",
    url: "https://www.exchangerate-api.com",
    category: "data",
    description: "Currency exchange rates. Free tier with daily updates.",
    requiresSignup: false,
    apiEndpoint: "https://open.er-api.com/v6/latest/{currency}",
    authMethod: "none",
    freeLimit: "Unlimited (open endpoint)",
    tags: ["currency", "exchange", "finance", "rates"],
  },

  // ── Utilities ──
  {
    name: "QR Code Generator",
    url: "https://goqr.me/api/",
    category: "utilities",
    description: "Generate QR codes via URL. No signup needed.",
    requiresSignup: false,
    apiEndpoint: "https://api.qrserver.com/v1/create-qr-code/",
    authMethod: "none",
    freeLimit: "Unlimited",
    tags: ["qr-code", "generate", "barcode"],
  },
  {
    name: "IP-API",
    url: "https://ip-api.com",
    category: "utilities",
    description: "IP geolocation API. Get location data from IP addresses.",
    requiresSignup: false,
    apiEndpoint: "http://ip-api.com/json/{ip}",
    authMethod: "none",
    freeLimit: "45 requests/minute",
    tags: ["ip", "geolocation", "location"],
  },
  {
    name: "URL Shortener (CleanURI)",
    url: "https://cleanuri.com",
    category: "utilities",
    description: "Shorten URLs via simple API. No signup.",
    requiresSignup: false,
    apiEndpoint: "https://cleanuri.com/api/v1/shorten",
    authMethod: "none",
    freeLimit: "Unlimited",
    tags: ["url", "shorten", "link"],
  },

  // ── AI ──
  {
    name: "Hugging Face Inference",
    url: "https://huggingface.co/inference-api",
    category: "ai",
    description: "Free inference API for thousands of ML models: text generation, classification, image generation, etc.",
    requiresSignup: true,
    apiEndpoint: "https://api-inference.huggingface.co/models/{model}",
    authMethod: "api-key",
    freeLimit: "Rate-limited free tier",
    tags: ["ai", "ml", "inference", "text-generation", "image-generation"],
  },

  // ── Storage ──
  {
    name: "File.io",
    url: "https://www.file.io",
    category: "storage",
    description: "Ephemeral file sharing. Upload files that auto-delete after first download.",
    requiresSignup: false,
    apiEndpoint: "https://file.io",
    authMethod: "none",
    freeLimit: "100MB max file, ephemeral",
    tags: ["file-sharing", "upload", "temporary", "storage"],
  },
  {
    name: "transfer.sh",
    url: "https://transfer.sh",
    category: "storage",
    description: "Upload files from CLI. Files available for 14 days.",
    requiresSignup: false,
    apiEndpoint: "https://transfer.sh/{filename}",
    authMethod: "none",
    freeLimit: "10GB max, 14 day retention",
    tags: ["file-sharing", "upload", "cli", "storage"],
  },

  // ── Communication ──
  {
    name: "ntfy.sh",
    url: "https://ntfy.sh",
    category: "communication",
    description: "Push notifications via HTTP. Send alerts to phone/desktop without signup.",
    requiresSignup: false,
    apiEndpoint: "https://ntfy.sh/{topic}",
    authMethod: "none",
    freeLimit: "Unlimited",
    tags: ["notification", "push", "alert", "webhook"],
  },
];

// ─── Search Logic ───────────────────────────────────────────────────────────────

function scoreResource(entry: ResourceEntry, need: string, category?: string, noSignup?: boolean): number {
  if (noSignup && entry.requiresSignup) return 0;
  if (category && entry.category !== category) return 0;

  const q = need.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  let score = 0;

  const searchable = [
    entry.name,
    entry.description,
    entry.category,
    ...entry.tags,
  ].join(" ").toLowerCase();

  for (const word of words) {
    if (searchable.includes(word)) score += 2;
  }

  // Boost no-signup resources
  if (!entry.requiresSignup) score += 1;

  // Boost resources with API endpoints
  if (entry.apiEndpoint) score += 0.5;

  return score;
}

function formatResource(entry: ResourceEntry, index: number): string {
  const signup = entry.requiresSignup
    ? `Requires signup (${entry.authMethod})`
    : "No signup needed";
  const api = entry.apiEndpoint ? `API: ${entry.apiEndpoint}` : "No direct API";
  return [
    `${index + 1}. ${entry.name} [${entry.category}]`,
    `   ${entry.description}`,
    `   URL: ${entry.url}`,
    `   ${signup} | ${api}`,
    `   Free limit: ${entry.freeLimit}`,
    `   Tags: ${entry.tags.join(", ")}`,
  ].join("\n");
}

// ─── Tool Execute ───────────────────────────────────────────────────────────────

async function discoverResourceExecute(input: Record<string, unknown>): Promise<string> {
  const need = typeof input.need === "string" ? input.need.trim() : "";
  if (!need) return "Error: need is required. Describe what capability you're looking for.";

  const category = typeof input.category === "string" && (VALID_CATEGORIES as readonly string[]).includes(input.category)
    ? input.category
    : undefined;
  const noSignup = input.requires_no_signup === true;

  console.log(`[tool:discover_resource] "${need}" category=${category ?? "any"} noSignup=${noSignup}`);

  const scored = RESOURCE_REGISTRY
    .map((entry) => ({ entry, score: scoreResource(entry, need, category, noSignup) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (scored.length === 0) {
    return [
      `No resources found in the built-in registry for "${need}".`,
      "",
      "Try searching the web with:",
      `  web_search query="free API ${need}${noSignup ? " no signup" : ""}"`,
      "",
      "Or check if an MCP server exists:",
      `  mcp_search query="${need}"`,
    ].join("\n");
  }

  const results = scored.map((s, i) => formatResource(s.entry, i));
  const header = `Found ${scored.length} resource${scored.length > 1 ? "s" : ""} for "${need}":`;

  const sections = [header, "", ...results];

  if (scored.length < 3) {
    sections.push(
      "",
      "For more options, try:",
      `  web_search query="free API ${need}${noSignup ? " no signup" : ""}"`,
    );
  }

  return sections.join("\n");
}

// ─── Tool Export ────────────────────────────────────────────────────────────────

export const discoverResourceTool: EmberTool = {
  definition: {
    name: "discover_resource",
    description:
      "Search for free web services, APIs, and tools that can help accomplish a task. " +
      "Returns ranked service suggestions with registration methods and API details. " +
      "Use before attempting complex tasks locally — a web service may do it faster and better.",
    inputSchema: {
      type: "object",
      properties: {
        need: {
          type: "string",
          description: "What capability you need (e.g., 'temporary email', 'PDF to text', 'image resize', 'code formatting', 'weather data').",
        },
        category: {
          type: "string",
          enum: [...VALID_CATEGORIES],
          description: "Optional category filter.",
        },
        requires_no_signup: {
          type: "boolean",
          description: "If true, only return services that work without account creation.",
        },
      },
      required: ["need"],
    },
  },
  execute: discoverResourceExecute,
};
