import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EmberTool } from "./types.js";

function executeReadFile(input: Record<string, unknown>): string {
  const filePath = typeof input.path === "string" ? input.path : "";
  if (!filePath.trim()) return "Error: no path provided.";

  console.log(`[tool:read_file] ${filePath}`);

  try {
    const content = readFileSync(filePath, "utf8");
    if (content.length > 100_000) {
      return content.slice(0, 100_000) + "\n\n[truncated — file exceeds 100 KB]";
    }
    return content || "(empty file)";
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeWriteFile(input: Record<string, unknown>): string {
  const filePath = typeof input.path === "string" ? input.path : "";
  const content = typeof input.content === "string" ? input.content : "";
  if (!filePath.trim()) return "Error: no path provided.";

  console.log(`[tool:write_file] ${filePath}`);

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    return `Written: ${filePath}`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeEditFile(input: Record<string, unknown>): string {
  const filePath = typeof input.path === "string" ? input.path : "";
  const oldString = typeof input.old_string === "string" ? input.old_string : "";
  const newString = typeof input.new_string === "string" ? input.new_string : "";
  if (!filePath.trim()) return "Error: no path provided.";
  if (!oldString) return "Error: old_string is empty.";

  console.log(`[tool:edit_file] ${filePath}`);

  try {
    const current = readFileSync(filePath, "utf8");
    const count = current.split(oldString).length - 1;
    if (count === 0) return `Error: old_string not found in ${filePath}.`;
    if (count > 1) return `Error: old_string appears ${count} times in ${filePath} — make it more specific.`;
    const updated = current.replace(oldString, newString);
    writeFileSync(filePath, updated, "utf8");
    return `Edited: ${filePath}`;
  } catch (err) {
    return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const readFileTool: EmberTool = {
  definition: {
    name: "read_file",
    description:
      "Read the contents of a file at the given path. Returns the file contents as text. " +
      "Always read a file before attempting to edit it so you know the exact current content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file to read.",
        },
      },
      required: ["path"],
    },
  },
  systemPrompt:
    "read_file — Read the real file contents before quoting, reasoning about, or editing a file.",
  execute: executeReadFile,
};

export const writeFileTool: EmberTool = {
  definition: {
    name: "write_file",
    description:
      "Write content to a file, creating it (and any missing parent directories) if it does not exist, " +
      "or fully overwriting it if it does. For targeted changes to an existing file, prefer edit_file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file to write.",
        },
        content: {
          type: "string",
          description: "The full content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
  },
  systemPrompt:
    "write_file — Create a file or fully replace its contents. Use only when a full write is intended; prefer edit_file for localized changes.",
  execute: executeWriteFile,
};

export const editFileTool: EmberTool = {
  definition: {
    name: "edit_file",
    description:
      "Replace an exact string in a file with a new string. The old_string must appear exactly once " +
      "in the file — read the file first to confirm the exact text. Use write_file for full rewrites.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file to edit.",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace. Must be unique in the file.",
        },
        new_string: {
          type: "string",
          description: "The string to replace it with.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  systemPrompt:
    "edit_file — Make a small exact replacement in an existing file. Read the file first and use a unique old_string.",
  execute: executeEditFile,
};
