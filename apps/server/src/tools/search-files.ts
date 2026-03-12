import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { EmberTool } from "./types.js";

const DEFAULT_RESULT_LIMIT = 200;
const MAX_RESULT_LIMIT = 1000;
const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = toPosixPath(glob.trim());
  let pattern = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*") {
      if (next === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      pattern += ".";
      continue;
    }

    pattern += escapeRegExp(char);
  }

  pattern += "$";
  return new RegExp(pattern);
}

function buildMatcher(query: string, fixedStrings: boolean, caseSensitive: boolean, multiline: boolean): {
  regex: RegExp;
  literal: string | null;
} {
  if (fixedStrings) {
    return {
      regex: new RegExp(escapeRegExp(query), caseSensitive ? "g" : "gi"),
      literal: caseSensitive ? query : query.toLowerCase(),
    };
  }

  const flags = ["g"];
  if (!caseSensitive) {
    flags.push("i");
  }
  if (multiline) {
    flags.push("s");
  }

  return {
    regex: new RegExp(query, flags.join("")),
    literal: null,
  };
}

function runSearch(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim();

  if (result.error) {
    return { ok: false, output: `Error: ${result.error.message}` };
  }

  return {
    ok: result.status === 0 || result.status === 1,
    output: combined,
  };
}

function getLineAndColumn(content: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;

  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content[cursor] === "\n") {
      line += 1;
      lineStart = cursor + 1;
    }
  }

  return {
    line,
    column: index - lineStart + 1,
  };
}

function getLineSnippet(content: string, index: number, matchLength: number): string {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  const lineEndCandidate = content.indexOf("\n", index + Math.max(matchLength, 1));
  const lineEnd = lineEndCandidate === -1 ? content.length : lineEndCandidate;
  const snippet = content.slice(lineStart, lineEnd).replace(/\r/g, "");
  return snippet.length > 500 ? `${snippet.slice(0, 500)}...` : snippet;
}

function collectFallbackMatches(
  content: string,
  matcher: { regex: RegExp; literal: string | null },
  fixedStrings: boolean,
  caseSensitive: boolean,
  limit: number,
): Array<{ index: number; length: number }> {
  const matches: Array<{ index: number; length: number }> = [];

  if (fixedStrings && matcher.literal !== null) {
    const haystack = caseSensitive ? content : content.toLowerCase();
    let fromIndex = 0;
    while (matches.length < limit) {
      const index = haystack.indexOf(matcher.literal, fromIndex);
      if (index === -1) {
        break;
      }
      matches.push({ index, length: matcher.literal.length });
      fromIndex = index + Math.max(matcher.literal.length, 1);
    }
    return matches;
  }

  matcher.regex.lastIndex = 0;
  for (const match of content.matchAll(matcher.regex)) {
    if (matches.length >= limit) {
      break;
    }
    const index = match.index ?? -1;
    if (index < 0) {
      continue;
    }
    matches.push({ index, length: match[0]?.length ?? 0 });
    if ((match[0]?.length ?? 0) === 0) {
      matcher.regex.lastIndex = index + 1;
    }
  }

  return matches;
}

function matchesFileType(filePath: string, fileType: string): boolean {
  if (!fileType) {
    return true;
  }

  const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
  if (extension === fileType.toLowerCase()) {
    return true;
  }

  const aliases: Record<string, string[]> = {
    js: ["cjs", "js", "jsx", "mjs"],
    ts: ["cts", "mts", "ts", "tsx"],
    py: ["py"],
    md: ["markdown", "md", "mdx"],
    yml: ["yaml", "yml"],
  };

  return (aliases[fileType.toLowerCase()] ?? []).includes(extension);
}

export function searchFilesFallback(input: {
  query: string;
  rootPath: string;
  glob: string;
  fileType: string;
  caseSensitive: boolean;
  fixedStrings: boolean;
  multiline: boolean;
  hidden: boolean;
  limit: number;
}): string {
  const matcher = buildMatcher(input.query, input.fixedStrings, input.caseSensitive, input.multiline);
  const globMatcher = input.glob ? globToRegExp(input.glob) : null;
  const results: string[] = [];
  const rootAbsolute = path.resolve(input.rootPath);

  const visit = (currentPath: string) => {
    if (results.length >= input.limit) {
      return;
    }

    let stats;
    try {
      stats = statSync(currentPath);
    } catch {
      return;
    }

    const name = path.basename(currentPath);
    if (!input.hidden && name.startsWith(".")) {
      return;
    }

    if (stats.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = readdirSync(currentPath);
      } catch {
        return;
      }

      for (const entry of entries) {
        visit(path.join(currentPath, entry));
        if (results.length >= input.limit) {
          break;
        }
      }
      return;
    }

    if (!stats.isFile() || stats.size > MAX_FALLBACK_FILE_BYTES) {
      return;
    }

    const relativePath = toPosixPath(path.relative(rootAbsolute, currentPath) || path.basename(currentPath));
    if (globMatcher && !globMatcher.test(relativePath)) {
      return;
    }
    if (!matchesFileType(currentPath, input.fileType)) {
      return;
    }

    let content = "";
    try {
      content = readFileSync(currentPath, "utf8");
    } catch {
      return;
    }

    const matches = collectFallbackMatches(
      content,
      matcher,
      input.fixedStrings,
      input.caseSensitive,
      input.limit - results.length,
    );

    for (const match of matches) {
      const location = getLineAndColumn(content, match.index);
      const snippet = getLineSnippet(content, match.index, match.length);
      results.push(`${relativePath}:${location.line}:${location.column}:${snippet}`);
      if (results.length >= input.limit) {
        break;
      }
    }
  };

  visit(rootAbsolute);
  return results.join("\n").trim() || "(no matches)";
}

function execute(input: Record<string, unknown>): string {
  const query =
    typeof input.query === "string" && input.query.trim()
      ? input.query.trim()
      : typeof input.text === "string"
        ? input.text.trim()
        : "";
  const rootPath = typeof input.path === "string" && input.path.trim() ? input.path.trim() : ".";
  const glob = typeof input.glob === "string" ? input.glob.trim() : "";
  const fileType = typeof input.file_type === "string" ? input.file_type.trim() : "";
  const caseSensitive = input.case_sensitive === true;
  const fixedStrings = input.fixed_strings === true || input.literal === true;
  const multiline = input.multiline === true;
  const hidden = input.include_hidden === true;
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? clamp(Math.floor(input.limit), 1, MAX_RESULT_LIMIT)
      : DEFAULT_RESULT_LIMIT;

  if (!query) {
    return "Error: query is required.";
  }

  console.log(`[tool:search_files] query="${query}" path="${rootPath}" limit=${limit}`);

  const rgArgs = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(limit),
  ];

  if (caseSensitive) {
    rgArgs.push("--case-sensitive");
  } else {
    rgArgs.push("--smart-case");
  }

  if (fixedStrings) {
    rgArgs.push("--fixed-strings");
  }

  if (multiline) {
    rgArgs.push("--multiline");
  }

  if (hidden) {
    rgArgs.push("--hidden");
  }

  if (glob) {
    rgArgs.push("-g", glob);
  }

  if (fileType) {
    rgArgs.push("-t", fileType);
  }

  rgArgs.push(query, rootPath);

  const rgCheck = spawnSync("rg", ["--version"], { encoding: "utf8" });
  const hasRg = !rgCheck.error && rgCheck.status === 0;

  if (hasRg) {
    const result = runSearch("rg", rgArgs);
    if (!result.ok) {
      return result.output || "Error: search failed.";
    }
    return result.output || "(no matches)";
  }

  try {
    return searchFilesFallback({
      query,
      rootPath,
      glob,
      fileType,
      caseSensitive,
      fixedStrings,
      multiline,
      hidden,
      limit,
    });
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const searchFilesTool: EmberTool = {
  definition: {
    name: "search_files",
    description:
      "Search file contents across a chosen local-machine path using ripgrep when available, with a built-in cross-platform fallback. " +
      "Returns path, line, and column matches. Use this to locate symbols, config keys, strings, TODOs, routes, prompts, or error messages before opening files.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term or regex pattern to find in files.",
        },
        text: {
          type: "string",
          description: "Alias for query. Useful for exact string searches.",
        },
        path: {
          type: "string",
          description: "Optional absolute or relative root path to search. Defaults to the current workspace/project root.",
        },
        glob: {
          type: "string",
          description: "Optional include glob such as '*.ts' or 'apps/server/**'.",
        },
        file_type: {
          type: "string",
          description: "Optional file type such as 'ts', 'js', 'json', or 'md'.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Set to true for case-sensitive search.",
        },
        fixed_strings: {
          type: "boolean",
          description: "Set to true to treat the query as a literal string instead of a regex.",
        },
        literal: {
          type: "boolean",
          description: "Alias for fixed_strings=true.",
        },
        multiline: {
          type: "boolean",
          description: "Set to true to enable multiline regex search.",
        },
        include_hidden: {
          type: "boolean",
          description: "Set to true to include hidden files and directories.",
        },
        limit: {
          type: "number",
          description: "Maximum number of matches to return. Default 200, maximum 1000.",
        },
      },
      required: ["query"],
    },
  },
  execute,
};
