/**
 * Dynamic Tool Plugin Interface
 *
 * Scans a plugin directory for tool definitions and registers them
 * with the tool registry at startup. Supports hot-reload via API.
 *
 * Plugin format: each plugin is a directory containing a `plugin.json` manifest
 * and one or more `.js` files that export EmberTool objects.
 *
 * Directory structure:
 *   <data-root>/plugins/
 *     my-plugin/
 *       plugin.json   ← manifest (name, version, tools, roles)
 *       handler.js    ← tool implementation(s)
 */

import { getDataRoot } from "@ember/core";
import type { Role } from "@ember/core";
import path from "node:path";
import { readdir, readFile, mkdir } from "node:fs/promises";
import type { EmberTool } from "./types.js";

export interface EmberToolPlugin {
  /** Unique plugin identifier (directory name) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version string */
  version: string;
  /** Tools provided by this plugin */
  tools: EmberTool[];
  /** Which roles can access these tools (empty = all roles) */
  roles: Role[];
  /** Path to plugin directory */
  pluginDir: string;
  /** Cleanup callback */
  cleanup?: () => Promise<void>;
}

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  /** Relative path to the handler module (default: "handler.js") */
  handler?: string;
  /** Roles that get access to this plugin's tools (default: all roles) */
  roles?: string[];
  /** Tool priority override (1-5) */
  priority?: number;
}

const VALID_ROLES: ReadonlySet<string> = new Set([
  "dispatch", "coordinator", "advisor", "director", "inspector", "ops",
]);

const PLUGIN_DIR_NAME = "plugins";

function getPluginDir(): string {
  return path.join(getDataRoot(), PLUGIN_DIR_NAME);
}

/**
 * Load all plugins from the plugins directory.
 * Returns loaded plugins; logs warnings for malformed ones but never throws.
 */
export async function loadToolPlugins(): Promise<EmberToolPlugin[]> {
  const pluginDir = getPluginDir();
  try {
    await mkdir(pluginDir, { recursive: true });
  } catch {
    // Best-effort
  }

  let entries: string[];
  try {
    const dirEntries = await readdir(pluginDir, { withFileTypes: true });
    entries = dirEntries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const plugins: EmberToolPlugin[] = [];
  for (const dirName of entries) {
    try {
      const plugin = await loadSinglePlugin(pluginDir, dirName);
      if (plugin) {
        plugins.push(plugin);
      }
    } catch (error) {
      console.warn(
        `[plugins] Failed to load plugin "${dirName}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (plugins.length > 0) {
    console.log(
      `[plugins] Loaded ${plugins.length} plugin(s): ${plugins.map((p) => `${p.name}@${p.version}`).join(", ")}`,
    );
  }

  return plugins;
}

async function loadSinglePlugin(
  pluginDir: string,
  dirName: string,
): Promise<EmberToolPlugin | null> {
  const manifestPath = path.join(pluginDir, dirName, "plugin.json");
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, "utf8");
  } catch {
    console.warn(`[plugins] Skipping "${dirName}": no plugin.json manifest`);
    return null;
  }

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(manifestRaw) as PluginManifest;
  } catch {
    console.warn(`[plugins] Skipping "${dirName}": malformed plugin.json`);
    return null;
  }

  if (!manifest.name || !manifest.version) {
    console.warn(`[plugins] Skipping "${dirName}": manifest missing name or version`);
    return null;
  }

  // Validate roles
  const roles: Role[] = [];
  if (manifest.roles && Array.isArray(manifest.roles)) {
    for (const r of manifest.roles) {
      if (VALID_ROLES.has(r)) {
        roles.push(r as Role);
      }
    }
  }
  if (roles.length === 0) {
    // Default: available to coordinator, advisor, director, inspector
    roles.push("coordinator", "advisor", "director", "inspector");
  }

  // Load handler module
  const handlerFile = manifest.handler ?? "handler.js";
  const handlerPath = path.join(pluginDir, dirName, handlerFile);
  let handlerModule: Record<string, unknown>;
  try {
    handlerModule = (await import(handlerPath)) as Record<string, unknown>;
  } catch (error) {
    console.warn(
      `[plugins] Skipping "${dirName}": failed to load handler "${handlerFile}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  // Extract tools from the module
  const tools: EmberTool[] = [];
  const priority = manifest.priority ?? 4; // Default to advanced priority for plugins

  // Support both named exports and a default `tools` array export
  if (Array.isArray(handlerModule.tools)) {
    for (const tool of handlerModule.tools) {
      if (isValidEmberTool(tool)) {
        tools.push({ ...tool, priority: tool.priority ?? priority });
      }
    }
  } else if (handlerModule.default && Array.isArray(handlerModule.default)) {
    for (const tool of handlerModule.default) {
      if (isValidEmberTool(tool)) {
        tools.push({ ...tool, priority: tool.priority ?? priority });
      }
    }
  } else {
    // Check all named exports for EmberTool-shaped objects
    for (const value of Object.values(handlerModule)) {
      if (isValidEmberTool(value)) {
        tools.push({ ...value, priority: value.priority ?? priority });
      }
    }
  }

  if (tools.length === 0) {
    console.warn(`[plugins] Skipping "${dirName}": no valid tools found in handler`);
    return null;
  }

  // Namespace tool names with plugin: prefix to avoid collisions
  for (const tool of tools) {
    if (!tool.definition.name.startsWith("plugin:")) {
      tool.definition.name = `plugin:${dirName}:${tool.definition.name}`;
    }
  }

  const cleanup = typeof handlerModule.cleanup === "function"
    ? (handlerModule.cleanup as () => Promise<void>)
    : undefined;

  return {
    id: dirName,
    name: manifest.name,
    version: manifest.version,
    tools,
    roles,
    pluginDir: path.join(pluginDir, dirName),
    cleanup,
  };
}

function isValidEmberTool(value: unknown): value is EmberTool {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!candidate.definition || typeof candidate.definition !== "object") return false;
  const def = candidate.definition as Record<string, unknown>;
  if (typeof def.name !== "string" || typeof def.description !== "string") return false;
  if (typeof candidate.execute !== "function") return false;
  return true;
}

/** Loaded plugin instances for cleanup on reload. */
let activePlugins: EmberToolPlugin[] = [];

export function getActivePlugins(): ReadonlyArray<EmberToolPlugin> {
  return activePlugins;
}

export function setActivePlugins(plugins: EmberToolPlugin[]): void {
  activePlugins = plugins;
}

/**
 * Clean up all active plugins (call their cleanup functions).
 */
export async function cleanupPlugins(): Promise<void> {
  for (const plugin of activePlugins) {
    try {
      await plugin.cleanup?.();
    } catch (error) {
      console.warn(
        `[plugins] Cleanup failed for "${plugin.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  activePlugins = [];
}
