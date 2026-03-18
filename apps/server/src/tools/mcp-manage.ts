/**
 * MCP management tools — let the agent discover and install MCP servers on demand.
 *
 * mcp_search  — search curated registry + npm for MCP servers by keyword
 * mcp_install — install a package as a new MCP server at runtime
 */

import type { ToolResult } from "@ember/core";
import type { EmberTool } from "./types.js";
import { searchCuratedRegistry, formatRegistryEntry, CURATED_REGISTRY, type McpRegistryEntry } from "../mcp/registry.js";

// ── npm registry search ──────────────────────────────────────────────────────

interface NpmSearchResult {
  package: {
    name: string;
    version: string;
    description?: string;
    keywords?: string[];
  };
  score?: { final?: number };
}

async function searchNpmRegistry(query: string, limit = 15): Promise<NpmSearchResult[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const data = (await response.json()) as { objects?: NpmSearchResult[] };
    return data.objects ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function formatNpmResult(result: NpmSearchResult): string {
  const pkg = result.package;
  return [
    `**${pkg.name}** (v${pkg.version})`,
    pkg.description ?? "(no description)",
    pkg.keywords?.length ? `Tags: ${pkg.keywords.slice(0, 8).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

// ── Install callback type ────────────────────────────────────────────────────

export interface McpInstallContext {
  /**
   * Install and reload an MCP server at runtime.
   * Called by mcp_install tool. Wired to the upsert + reload flow in index.ts.
   */
  installServer: (options: {
    packageName: string;
    serverName?: string;
    roles: string[];
    env?: Record<string, string>;
    args?: string[];
    timeout?: number;
    scope?: "user" | "project";
  }) => Promise<{ serverCount: number; toolCount: number }>;
}

let installContext: McpInstallContext | null = null;

/**
 * Called once at startup to wire the install callback.
 */
export function setMcpInstallContext(ctx: McpInstallContext): void {
  installContext = ctx;
}

// ── mcp_search tool ──────────────────────────────────────────────────────────

export const mcpSearchTool: EmberTool = {
  definition: {
    name: "mcp_search",
    description:
      "Search for MCP servers that provide new capabilities. Searches a curated registry of known servers and the npm package registry. Use this when you need a tool you don't currently have — email, database, cloud services, etc.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What capability you're looking for (e.g., 'email', 'database', 'slack', 'aws').",
        },
        source: {
          type: "string",
          enum: ["all", "curated", "npm"],
          description: "Where to search. 'curated' = tested registry only, 'npm' = npm packages, 'all' = both (default).",
        },
      },
      required: ["query"],
    },
  },
  execute: async (input): Promise<ToolResult> => {
    const query = (input.query as string ?? "").trim();
    if (!query) return "Error: query is required.";

    const source = (input.source as string ?? "all").toLowerCase();
    const results: string[] = [];

    // Search curated registry
    if (source === "all" || source === "curated") {
      const curated = searchCuratedRegistry(query);
      if (curated.length > 0) {
        results.push("## Curated Registry (tested & recommended)\n");
        for (const entry of curated.slice(0, 8)) {
          results.push(formatRegistryEntry(entry));
          results.push("");
        }
      } else {
        results.push("No matches in curated registry.\n");
      }
    }

    // Search npm
    if (source === "all" || source === "npm") {
      const npmQuery = `mcp server ${query}`;
      const npmResults = await searchNpmRegistry(npmQuery);

      // Filter to likely MCP servers and exclude curated entries
      const curatedPackages = new Set(CURATED_REGISTRY.map((e) => e.package));
      const filtered = npmResults.filter((r) => {
        const name = r.package.name.toLowerCase();
        const desc = (r.package.description ?? "").toLowerCase();
        const keywords = (r.package.keywords ?? []).join(" ").toLowerCase();
        const text = `${name} ${desc} ${keywords}`;
        // Must look like an MCP server
        return (text.includes("mcp") || text.includes("model-context-protocol")) && !curatedPackages.has(r.package.name);
      });

      if (filtered.length > 0) {
        results.push("## npm Registry (community packages)\n");
        for (const entry of filtered.slice(0, 8)) {
          results.push(formatNpmResult(entry));
          results.push("");
        }
      } else if (source === "npm") {
        results.push("No MCP server packages found on npm for this query.");
      }
    }

    if (results.length === 0) {
      return `No MCP servers found for "${query}". Try broader terms.`;
    }

    results.push("---");
    results.push("To install a server, use mcp_install with the package name.");

    return results.join("\n");
  },
};

// ── mcp_install tool ─────────────────────────────────────────────────────────

export const mcpInstallTool: EmberTool = {
  definition: {
    name: "mcp_install",
    description:
      "Install and activate an MCP server package at runtime. The server's tools become available immediately after installation. Use mcp_search first to find the right package.",
    inputSchema: {
      type: "object",
      properties: {
        package_name: {
          type: "string",
          description: "The npm package name to install (e.g., '@modelcontextprotocol/server-memory').",
        },
        server_name: {
          type: "string",
          description: "Optional short name for the server. Derived from package name if omitted.",
        },
        env: {
          type: "object",
          description: "Environment variables for the server (API keys, tokens, etc.).",
          additionalProperties: { type: "string" },
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Extra CLI arguments to pass to the server (beyond the package name).",
        },
        roles: {
          type: "array",
          items: { type: "string", enum: ["coordinator", "advisor", "director", "inspector", "ops"] },
          description: "Which Ember roles can use this server's tools. Default: coordinator, advisor, director, inspector.",
        },
        scope: {
          type: "string",
          enum: ["user", "project"],
          description: "Where to save the config. 'user' = ~/.ember/mcp.json (persists globally), 'project' = .ember/mcp.json (this project only). Default: user.",
        },
      },
      required: ["package_name"],
    },
  },
  execute: async (input): Promise<ToolResult> => {
    if (!installContext) {
      return "Error: MCP install system not initialized. Server may still be starting up.";
    }

    const packageName = (input.package_name as string ?? "").trim();
    if (!packageName) return "Error: package_name is required.";

    const serverName = (input.server_name as string | undefined)?.trim() || undefined;
    const env = input.env as Record<string, string> | undefined;
    const args = input.args as string[] | undefined;
    const roles = (input.roles as string[] | undefined) ?? ["coordinator", "advisor", "director", "inspector"];
    const scope = (input.scope as "user" | "project" | undefined) ?? "user";

    // Check curated registry for recommended config
    const curated = CURATED_REGISTRY.find((e) => e.package === packageName);
    const mergedEnv = { ...(curated?.env ?? {}), ...(env ?? {}) };
    const mergedArgs = args ?? curated?.args;
    const timeout = curated?.timeout ?? 30_000;

    // Check for missing required keys
    if (curated?.requiresKeys && curated.env) {
      const missing = Object.entries(curated.env)
        .filter(([key]) => !mergedEnv[key]?.trim())
        .map(([key]) => key);
      if (missing.length > 0) {
        return [
          `Warning: ${curated.name} requires API keys that are not set:`,
          ...missing.map((k) => `  - ${k}`),
          "",
          "The server will be installed but may fail to operate until keys are configured.",
          "You can set them in Settings > MCP > Service Keys, or pass them in the 'env' parameter.",
          "",
          "Installing anyway...",
        ].join("\n") + "\n\n" + await doInstall();
      }
    }

    return doInstall();

    async function doInstall(): Promise<string> {
      try {
        const result = await installContext!.installServer({
          packageName,
          serverName,
          roles,
          env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
          args: mergedArgs,
          timeout,
          scope,
        });

        return [
          `Installed MCP server "${serverName ?? packageName}".`,
          `${result.serverCount} server(s) running, ${result.toolCount} total tool(s) available.`,
          "",
          "The server's tools are now active and available for use.",
        ].join("\n");
      } catch (err) {
        return `Failed to install MCP server: ${(err as Error).message}`;
      }
    }
  },
};
