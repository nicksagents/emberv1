import { Dirent, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { EmberTool } from "./types.js";

const MAX_READ_CHARS = 100_000;
const DEFAULT_DIRECTORY_LIMIT = 200;

function formatPath(inputPath: string): string {
  try {
    return resolve(inputPath);
  } catch {
    return inputPath;
  }
}

function executeReadFile(input: Record<string, unknown>): string {
  const filePath =
    typeof input.path === "string" && input.path.trim()
      ? input.path
      : typeof input.file === "string"
        ? input.file
        : "";
  const startLine =
    typeof input.start_line === "number" && Number.isFinite(input.start_line)
      ? Math.max(1, Math.floor(input.start_line))
      : null;
  const endLine =
    typeof input.end_line === "number" && Number.isFinite(input.end_line)
      ? Math.max(1, Math.floor(input.end_line))
      : null;
  if (!filePath.trim()) return "Error: no path provided.";

  console.log(`[tool:read_file] ${filePath}`);

  try {
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      return `Error: ${filePath} is a directory. Use list_directory for folders.`;
    }

    const content = readFileSync(filePath, "utf8");
    if (startLine !== null || endLine !== null) {
      const lines = content.split("\n");
      const from = startLine ?? 1;
      const to = Math.min(endLine ?? lines.length, lines.length);
      if (from > to) {
        return `Error: start_line (${from}) must be less than or equal to end_line (${to}).`;
      }
      const slice = lines.slice(from - 1, to);
      const numbered = slice
        .map((line, index) => `${String(from + index).padStart(5, " ")} | ${line}`)
        .join("\n");
      return (
        `Path: ${formatPath(filePath)}\n` +
        `Lines: ${from}-${to} of ${lines.length}\n\n` +
        (numbered || "(empty selection)")
      );
    }

    if (content.length > MAX_READ_CHARS) {
      return content.slice(0, MAX_READ_CHARS) + "\n\n[truncated — file exceeds 100 KB]";
    }
    return content || "(empty file)";
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeWriteFile(input: Record<string, unknown>): string {
  const filePath = typeof input.path === "string" ? input.path : "";
  const content = typeof input.content === "string" ? input.content : "";
  const append = input.append === true;
  if (!filePath.trim()) return "Error: no path provided.";

  console.log(`[tool:write_file] ${filePath}${append ? " (append)" : ""}`);

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, { encoding: "utf8", flag: append ? "a" : "w" });
    return `${append ? "Appended" : "Written"}: ${filePath}`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeEditFile(input: Record<string, unknown>): string {
  const filePath = typeof input.path === "string" ? input.path : "";
  const oldString = typeof input.old_string === "string" ? input.old_string : "";
  const newString = typeof input.new_string === "string" ? input.new_string : "";
  const replaceAll = input.replace_all === true;
  const expectedReplacements =
    typeof input.expected_replacements === "number" && Number.isFinite(input.expected_replacements)
      ? Math.max(1, Math.floor(input.expected_replacements))
      : null;
  if (!filePath.trim()) return "Error: no path provided.";
  if (!oldString) return "Error: old_string is empty.";

  console.log(`[tool:edit_file] ${filePath}${replaceAll ? " (replace_all)" : ""}`);

  try {
    const current = readFileSync(filePath, "utf8");
    const count = current.split(oldString).length - 1;
    if (count === 0) return `Error: old_string not found in ${filePath}.`;
    if (expectedReplacements !== null && count !== expectedReplacements) {
      return `Error: old_string appears ${count} times in ${filePath}, expected ${expectedReplacements}.`;
    }
    if (!replaceAll && count > 1) {
      return `Error: old_string appears ${count} times in ${filePath} — make it more specific or set replace_all=true.`;
    }
    const updated = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
    writeFileSync(filePath, updated, "utf8");
    return `Edited: ${filePath} (${replaceAll ? count : 1} replacement${replaceAll || count !== 1 ? "s" : ""})`;
  } catch (err) {
    return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function describeDirectoryEntry(basePath: string, entry: Dirent): string {
  const fullPath = join(basePath, entry.name);
  const suffix = entry.isDirectory()
    ? "/"
    : entry.isSymbolicLink()
      ? "@"
      : entry.isFIFO()
        ? "|"
        : "";
  return `${entry.name}${suffix}  ${formatPath(fullPath)}`;
}

function walkDirectory(
  rootPath: string,
  depth: number,
  includeHidden: boolean,
  limit: number,
  prefix = "",
  results: string[] = [],
): string[] {
  if (results.length >= limit) {
    return results;
  }

  const entries = readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => includeHidden || !entry.name.startsWith("."))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });

  for (const entry of entries) {
    if (results.length >= limit) {
      break;
    }

    results.push(`${prefix}${describeDirectoryEntry(rootPath, entry)}`);

    if (depth > 0 && entry.isDirectory()) {
      walkDirectory(join(rootPath, entry.name), depth - 1, includeHidden, limit, `${prefix}  `, results);
    }
  }

  return results;
}

function executeListDirectory(input: Record<string, unknown>): string {
  const directoryPath = typeof input.path === "string" ? input.path : "";
  const recursive = input.recursive === true;
  const includeHidden = input.include_hidden === true;
  const depth =
    typeof input.max_depth === "number" && Number.isFinite(input.max_depth)
      ? Math.max(0, Math.floor(input.max_depth))
      : recursive
        ? 3
        : 0;
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.max(1, Math.min(1000, Math.floor(input.limit)))
      : DEFAULT_DIRECTORY_LIMIT;

  if (!directoryPath.trim()) return "Error: no path provided.";

  console.log(`[tool:list_directory] ${directoryPath}${recursive ? ` (depth=${depth})` : ""}`);

  try {
    const stats = statSync(directoryPath);
    if (!stats.isDirectory()) {
      return `Error: ${directoryPath} is not a directory.`;
    }

    const items = walkDirectory(directoryPath, depth, includeHidden, limit);
    const suffix = items.length >= limit ? `\n\n[truncated — reached limit ${limit}]` : "";
    return `Directory: ${formatPath(directoryPath)}\nEntries: ${items.length}${suffix}\n\n${items.join("\n") || "(empty directory)"}`;
  } catch (err) {
    return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
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
        file: {
          type: "string",
          description: "Alias for path.",
        },
        start_line: {
          type: "number",
          description: "Optional 1-based starting line number for partial reads.",
        },
        end_line: {
          type: "number",
          description: "Optional 1-based ending line number for partial reads.",
        },
      },
      required: ["path"],
    },
  },
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
        append: {
          type: "boolean",
          description: "Set to true to append instead of overwriting the file.",
        },
      },
      required: ["path", "content"],
    },
  },
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
        replace_all: {
          type: "boolean",
          description: "Set to true to replace every occurrence of old_string instead of requiring exactly one.",
        },
        expected_replacements: {
          type: "number",
          description: "Optional exact number of occurrences you expect before editing.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  execute: executeEditFile,
};

export const listDirectoryTool: EmberTool = {
  definition: {
    name: "list_directory",
    description:
      "List the contents of a directory. Supports recursive listing, depth limits, hidden files, and entry limits. " +
      "Use this before reading or editing when you need to discover files or inspect repository structure.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the directory to inspect.",
        },
        recursive: {
          type: "boolean",
          description: "Set to true to walk subdirectories.",
        },
        max_depth: {
          type: "number",
          description: "Maximum recursion depth when recursive=true. Default 3.",
        },
        include_hidden: {
          type: "boolean",
          description: "Set to true to include dotfiles and hidden directories.",
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return. Default 200, maximum 1000.",
        },
      },
      required: ["path"],
    },
  },
  execute: executeListDirectory,
};
