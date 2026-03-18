/**
 * Curated MCP server registry for on-demand discovery.
 *
 * The agent can search this registry (and npm) to find MCP servers that
 * provide capabilities it doesn't currently have.
 */

export interface McpRegistryEntry {
  /** npm package name */
  package: string;
  /** Human-friendly name */
  name: string;
  /** What this server does */
  description: string;
  /** Searchable tags */
  tags: string[];
  /** Env vars required (empty string = user must fill in) */
  env?: Record<string, string>;
  /** Default CLI args beyond the package name */
  args?: string[];
  /** Suggested roles */
  roles: string[];
  /** Timeout in ms */
  timeout?: number;
  /** Whether this needs API keys to function */
  requiresKeys?: boolean;
}

/**
 * Curated list of known, tested MCP servers.
 * Searched first before falling back to npm registry.
 */
export const CURATED_REGISTRY: McpRegistryEntry[] = [
  // ── Official / Anthropic ────────────────────────────────────────────────
  {
    package: "@modelcontextprotocol/server-filesystem",
    name: "Filesystem",
    description: "Read, write, and manage files and directories on the host machine.",
    tags: ["files", "filesystem", "read", "write", "directory"],
    roles: ["coordinator", "advisor", "director", "inspector", "ops"],
    timeout: 30_000,
  },
  {
    package: "@modelcontextprotocol/server-memory",
    name: "Knowledge Graph Memory",
    description: "Persistent knowledge graph for storing entities and relations. Good for architecture maps, project relationships, and structured domain models.",
    tags: ["memory", "knowledge", "graph", "entities", "relations", "storage"],
    roles: ["coordinator", "advisor", "director", "inspector"],
    timeout: 30_000,
  },
  {
    package: "@modelcontextprotocol/server-github",
    name: "GitHub",
    description: "GitHub API access — repos, issues, PRs, branches, code search, and file operations.",
    tags: ["github", "git", "repos", "issues", "pull-requests", "code-search", "vcs"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    roles: ["coordinator", "advisor", "director", "inspector"],
    timeout: 30_000,
    requiresKeys: true,
  },
  {
    package: "@modelcontextprotocol/server-gitlab",
    name: "GitLab",
    description: "GitLab API — projects, issues, merge requests, and repository operations.",
    tags: ["gitlab", "git", "merge-requests", "issues", "vcs"],
    env: { GITLAB_PERSONAL_ACCESS_TOKEN: "", GITLAB_API_URL: "https://gitlab.com/api/v4" },
    roles: ["coordinator", "advisor", "director", "inspector"],
    timeout: 30_000,
    requiresKeys: true,
  },
  {
    package: "@modelcontextprotocol/server-brave-search",
    name: "Brave Search",
    description: "Web and local search powered by the Brave Search API.",
    tags: ["search", "web", "brave", "internet"],
    env: { BRAVE_API_KEY: "" },
    roles: ["coordinator", "advisor", "director", "inspector"],
    timeout: 15_000,
    requiresKeys: true,
  },
  {
    package: "@modelcontextprotocol/server-slack",
    name: "Slack",
    description: "Slack workspace access — read channels, post messages, search conversations, and manage threads.",
    tags: ["slack", "chat", "messaging", "communication", "channels"],
    env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    roles: ["coordinator", "advisor"],
    timeout: 15_000,
    requiresKeys: true,
  },
  {
    package: "@modelcontextprotocol/server-postgres",
    name: "PostgreSQL",
    description: "Read-only PostgreSQL access — schema inspection and SELECT queries.",
    tags: ["postgres", "postgresql", "database", "sql", "db", "query"],
    roles: ["coordinator", "advisor", "director", "inspector"],
    timeout: 30_000,
    requiresKeys: true,
  },
  {
    package: "@modelcontextprotocol/server-google-maps",
    name: "Google Maps",
    description: "Geocoding, directions, place search, and distance calculations.",
    tags: ["maps", "google", "geocoding", "directions", "places", "location"],
    env: { GOOGLE_MAPS_API_KEY: "" },
    roles: ["coordinator", "advisor"],
    timeout: 15_000,
    requiresKeys: true,
  },
  {
    package: "@modelcontextprotocol/server-sequential-thinking",
    name: "Sequential Thinking",
    description: "Structured multi-step reasoning for complex problem decomposition, planning, and analysis.",
    tags: ["thinking", "reasoning", "planning", "analysis", "chain-of-thought"],
    roles: ["coordinator", "advisor", "director", "inspector"],
    timeout: 30_000,
  },
  {
    package: "@playwright/mcp",
    name: "Playwright Browser",
    description: "Browser automation for login flows, form interaction, screenshots, and UI verification.",
    tags: ["browser", "web", "automation", "playwright", "scraping", "testing"],
    roles: ["coordinator", "advisor", "director", "inspector"],
    timeout: 60_000,
  },
  // ── Email ───────────────────────────────────────────────────────────────
  {
    package: "gmail-mcp-imap",
    name: "Gmail (IMAP/SMTP)",
    description: "Gmail email management — read inbox, search, send, reply, manage labels and categories. Uses IMAP/SMTP with App Password authentication.",
    tags: ["email", "gmail", "imap", "smtp", "mail", "inbox", "send", "google"],
    env: { GMAIL_EMAIL: "", GMAIL_APP_PASSWORD: "" },
    roles: ["coordinator", "advisor"],
    timeout: 30_000,
    requiresKeys: true,
  },
  {
    package: "mcp-outlook-mail",
    name: "Outlook Mail",
    description: "Microsoft Outlook/365 email management via Graph API — read, send, search, and manage emails with Device Flow auth.",
    tags: ["email", "outlook", "microsoft", "office365", "mail", "inbox", "send"],
    env: { MICROSOFT_CLIENT_ID: "", MICROSOFT_TENANT_ID: "" },
    roles: ["coordinator", "advisor"],
    timeout: 30_000,
    requiresKeys: true,
  },
  // ── Data & APIs ─────────────────────────────────────────────────────────
  {
    package: "@modelcontextprotocol/server-puppeteer",
    name: "Puppeteer Browser",
    description: "Browser automation via Puppeteer — navigation, screenshots, form filling, and JavaScript evaluation.",
    tags: ["browser", "puppeteer", "web", "automation", "scraping"],
    roles: ["coordinator", "director", "inspector"],
    timeout: 60_000,
  },
  {
    package: "@modelcontextprotocol/server-everything",
    name: "Everything (Test)",
    description: "Test/demo MCP server that exercises all protocol features — tools, resources, prompts, sampling.",
    tags: ["test", "demo", "everything", "development"],
    roles: ["coordinator"],
    timeout: 15_000,
  },
];

/**
 * Search the curated registry by keyword.
 * Returns entries sorted by relevance (number of tag matches).
 */
export function searchCuratedRegistry(query: string): McpRegistryEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...CURATED_REGISTRY];

  const scored = CURATED_REGISTRY.map((entry) => {
    let score = 0;
    const searchable = [
      entry.name.toLowerCase(),
      entry.description.toLowerCase(),
      ...entry.tags,
      entry.package.toLowerCase(),
    ].join(" ");

    for (const term of terms) {
      if (searchable.includes(term)) score += 1;
      // Bonus for exact tag match
      if (entry.tags.includes(term)) score += 2;
      // Bonus for name match
      if (entry.name.toLowerCase().includes(term)) score += 3;
    }

    return { entry, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.entry);
}

/**
 * Format a registry entry for display to the agent.
 */
export function formatRegistryEntry(entry: McpRegistryEntry): string {
  const parts = [
    `**${entry.name}** (\`${entry.package}\`)`,
    entry.description,
  ];
  if (entry.requiresKeys && entry.env) {
    parts.push(`Requires: ${Object.keys(entry.env).join(", ")}`);
  }
  parts.push(`Tags: ${entry.tags.join(", ")}`);
  return parts.join("\n");
}
