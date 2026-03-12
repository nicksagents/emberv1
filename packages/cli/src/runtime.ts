import { existsSync } from "node:fs";
import path from "node:path";

import { resolveRepoRoot, type RuntimeState } from "@ember/core";

const WORKSPACE_MARKER = "pnpm-workspace.yaml";

function isWorkspaceRoot(target: string): boolean {
  return existsSync(path.join(target, WORKSPACE_MARKER));
}

export function resolveEmberRoot(
  from = process.cwd(),
  explicitRoot = process.env.EMBER_ROOT,
): string {
  const candidate = explicitRoot?.trim();
  if (candidate) {
    const resolved = path.resolve(candidate);
    if (isWorkspaceRoot(resolved)) {
      return resolved;
    }
  }

  return resolveRepoRoot(from);
}

export function hasManagedRuntime(runtime: Pick<RuntimeState, "serverPid" | "webPid">): boolean {
  return Boolean(runtime.serverPid || runtime.webPid);
}

export function appendNodeOption(existing: string | undefined, option: string): string {
  const current = existing?.trim() ?? "";
  if (!current) {
    return option;
  }
  const parts = current.split(/\s+/);
  if (parts.includes(option)) {
    return current;
  }
  return `${current} ${option}`;
}

export function buildRuntimeEnv(options: {
  repoRoot: string;
  runtimeHost: string;
  runtimePort: string;
  webHost: string;
  webPort: string;
  apiUrl: string;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = options.env ?? process.env;

  const runtimeEnv: NodeJS.ProcessEnv = {
    ...env,
    EMBER_ROOT: options.repoRoot,
    EMBER_RUNTIME_HOST: options.runtimeHost,
    EMBER_RUNTIME_PORT: options.runtimePort,
    EMBER_WEB_HOST: options.webHost,
    EMBER_WEB_PORT: options.webPort,
    NEXT_PUBLIC_API_URL: options.apiUrl,
    NODE_OPTIONS: appendNodeOption(env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"),
  };

  if (env.COREPACK_HOME) {
    runtimeEnv.COREPACK_HOME = env.COREPACK_HOME;
  }

  return runtimeEnv;
}
