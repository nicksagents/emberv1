/**
 * .env file loader — must be imported before any module that reads process.env.
 *
 * Walks up from CWD to find a .env file and loads it, without overriding
 * existing environment variables (shell/CLI takes precedence).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

let dir = process.cwd();
for (let i = 0; i < 5; i++) {
  const envPath = join(dir, ".env");
  if (existsSync(envPath)) {
    try {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    } catch {
      // Ignore parse errors
    }
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
