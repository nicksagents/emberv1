#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ensureDataFiles,
  initializeMemoryInfrastructure,
  readSettings,
  writeRuntime,
  defaultRuntime,
} from "../packages/core/dist/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

process.env.EMBER_ROOT = repoRoot;

await ensureDataFiles(repoRoot);
const settings = await readSettings();
await initializeMemoryInfrastructure(settings.memory);
await writeRuntime(defaultRuntime());
