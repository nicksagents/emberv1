import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { skillManager } from "@ember/core/skills";

// Point the SkillManager at the bundled skills directory so skill injection
// works in tests exactly as it does at runtime.
const __testDir = dirname(fileURLToPath(import.meta.url));
skillManager.initialize({
  bundledDir: join(__testDir, "..", "..", "..", "skills"),
});

import { deleteFileTool, editFileTool, listDirectoryTool, readFileTool, writeFileTool } from "./tools/files.js";
import { fetchPageTool } from "./tools/fetch-page.js";
import { gitInspectTool } from "./tools/git-inspect.js";
import { httpRequestTool } from "./tools/http-request.js";
import { forgetMemoryTool, memoryGetTool, memorySearchTool, saveMemoryTool } from "./tools/memory.js";
import { parallelTasksTool } from "./tools/parallel-tasks.js";
import { projectOverviewTool } from "./tools/project-overview.js";
import { searchFilesFallback, searchFilesTool } from "./tools/search-files.js";
import { createToolHandler, getExecutionToolsForRole, getToolSystemPrompt, registerMcpTools, replaceMcpTools } from "./tools/index.js";
import type { EmberTool } from "./tools/index.js";
import { terminalTool } from "./tools/terminal.js";

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ember-tools-"));
}

function expectText(result: unknown): string {
  if (typeof result !== "string") {
    throw new Error("Expected tool to return text.");
  }
  return result;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function makeNoopTool(name: string, description: string): EmberTool {
  return {
    definition: {
      name,
      description,
      inputSchema: { type: "object", properties: {} },
    },
    execute: async () => "ok",
  };
}

test("read_file supports line ranges", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "sample.txt");
  writeFileSync(filePath, "one\ntwo\nthree\nfour\n", "utf8");

  const result = expectText(await readFileTool.execute({
    path: filePath,
    start_line: 2,
    end_line: 3,
  }));

  assert.match(result, /Lines: 2-3 of 5/);
  assert.match(result, /2 \| two/);
  assert.match(result, /3 \| three/);
});

test("write_file can append and edit_file can replace all", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "append.txt");

  await writeFileTool.execute({ path: filePath, content: "a\n" });
  await writeFileTool.execute({ path: filePath, content: "b\n", append: true });
  const editResult = expectText(await editFileTool.execute({
    path: filePath,
    old_string: "\n",
    new_string: "!",
    replace_all: true,
    expected_replacements: 2,
  }));
  const final = expectText(await readFileTool.execute({ path: filePath }));

  assert.match(editResult, /2 replacements/);
  assert.equal(final, "a!b!");
});

test("delete_file removes files and requires recursive flag for directories", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "obsolete.txt");
  const nestedDir = path.join(dir, "nested");
  const nestedFile = path.join(nestedDir, "child.txt");
  writeFileSync(filePath, "old", "utf8");
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(nestedFile, "child", "utf8");

  const fileDelete = expectText(await deleteFileTool.execute({ path: filePath }));
  const dirDeleteWithoutRecursive = expectText(await deleteFileTool.execute({ path: nestedDir }));
  const dirDeleteRecursive = expectText(await deleteFileTool.execute({ path: nestedDir, recursive: true }));

  assert.match(fileDelete, /Deleted:/);
  assert.match(dirDeleteWithoutRecursive, /Set recursive=true/);
  assert.match(dirDeleteRecursive, /Deleted:/);
});

test("list_directory supports recursive listing", async () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, "nested", "deeper"), { recursive: true });
  writeFileSync(path.join(dir, "nested", "deeper", "file.txt"), "hi", "utf8");

  const result = expectText(await listDirectoryTool.execute({
    path: dir,
    recursive: true,
    max_depth: 2,
  }));

  assert.match(result, /Directory:/);
  assert.match(result, /nested\//);
  assert.match(result, /file\.txt/);
});

test("fetch_page formats JSON and includes links", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (href.endsWith("/json")) {
      return new Response(JSON.stringify({ ok: true, nested: { value: 42 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      '<html><head><title>Example</title></head><body><a href="/json">JSON Link</a><p>Hello</p></body></html>',
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }) as typeof fetch;

  try {
    const baseUrl = "https://example.test";
    const jsonResult = expectText(await fetchPageTool.execute({ url: `${baseUrl}/json` }));
    const htmlResult = expectText(await fetchPageTool.execute({ url: baseUrl, include_links: true }));

    assert.match(jsonResult, /"nested": \{/);
    assert.match(htmlResult, /Title: Example/);
    assert.match(htmlResult, /Links:/);
    assert.match(htmlResult, /JSON Link/);
    assert.match(htmlResult, /https:\/\/example\.test\/json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("search_files returns file, line, and matching content", async () => {
  const dir = tempDir();
  const srcDir = path.join(dir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "app.ts"), "const routerMode = 'strict';\nconsole.log(routerMode);\n", "utf8");
  writeFileSync(path.join(srcDir, "other.ts"), "const unrelated = true;\n", "utf8");

  const result = expectText(await searchFilesTool.execute({
    query: "routerMode",
    path: dir,
    file_type: "ts",
    fixed_strings: true,
  }));

  assert.match(result, /app\.ts:1:\d+:const routerMode = 'strict';/);
  assert.doesNotMatch(result, /other\.ts/);
});

test("search_files fallback works without ripgrep and respects hidden files", () => {
  const dir = tempDir();
  const visibleDir = path.join(dir, "pkg");
  const hiddenDir = path.join(dir, ".secret");
  mkdirSync(visibleDir, { recursive: true });
  mkdirSync(hiddenDir, { recursive: true });
  writeFileSync(path.join(visibleDir, "visible.ts"), "export const token = 'alpha';\n", "utf8");
  writeFileSync(path.join(hiddenDir, "hidden.ts"), "export const token = 'secret';\n", "utf8");

  const withoutHidden = searchFilesFallback({
    query: "token",
    rootPath: dir,
    glob: "**/*.ts",
    fileType: "ts",
    caseSensitive: false,
    fixedStrings: true,
    multiline: false,
    hidden: false,
    limit: 20,
  });
  const withHidden = searchFilesFallback({
    query: "token",
    rootPath: dir,
    glob: "**/*.ts",
    fileType: "ts",
    caseSensitive: false,
    fixedStrings: true,
    multiline: false,
    hidden: true,
    limit: 20,
  });

  assert.match(withoutHidden, /pkg\/visible\.ts:1:\d+:export const token = 'alpha';/);
  assert.doesNotMatch(withoutHidden, /\.secret\/hidden\.ts/);
  assert.match(withHidden, /\.secret\/hidden\.ts:1:\d+:export const token = 'secret';/);
});

test("http_request formats status, headers, and JSON body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ ok: true, items: [1, 2, 3] }), {
      status: 201,
      statusText: "Created",
      headers: {
        "content-type": "application/json",
        "x-trace-id": "abc123",
      },
    });
  }) as typeof fetch;

  try {
    const result = expectText(await httpRequestTool.execute({
      url: "https://api.example.test/items",
      method: "POST",
      json_body: JSON.stringify({ name: "demo" }),
      include_headers: true,
    }));

    assert.match(result, /Status: 201 Created/);
    assert.match(result, /URL: https:\/\/api\.example\.test\/items/);
    assert.match(result, /content-type: application\/json/);
    assert.match(result, /x-trace-id: abc123/);
    assert.match(result, /"items": \[/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("memory tools can save, search, inspect, and forget memories", async () => {
  const dir = tempDir();
  const previousRoot = process.env.EMBER_ROOT;
  process.env.EMBER_ROOT = dir;

  try {
    const saveResult = expectText(await saveMemoryTool.execute({
      content: "User prefers concise engineering answers.",
      memory_type: "user_preference",
      scope: "user",
      tags: ["style", "preference"],
    }));

    assert.match(saveResult, /Saved memory\./);
    const createdId = saveResult.match(/(mem_[a-z0-9_]+)/i)?.[1];
    assert.ok(createdId, "save_memory should return the created memory id");

    const reinforceResult = expectText(await saveMemoryTool.execute({
      content: "User prefers concise engineering answers.",
      memory_type: "user_preference",
      scope: "user",
      tags: ["style", "preference"],
    }));
    assert.match(reinforceResult, /Reinforced existing memory\./);
    assert.match(reinforceResult, new RegExp(createdId!));

    const searchResult = expectText(await memorySearchTool.execute({
      query: "How should you answer the user?",
    }));
    assert.match(searchResult, /Memory search results:/);
    assert.match(searchResult, /concise engineering answers/i);
    assert.match(searchResult, new RegExp(createdId!));

    const getResult = expectText(await memoryGetTool.execute({
      id: createdId,
    }));
    assert.match(getResult, /Status: active/);
    assert.match(getResult, /Type: user_preference/);
    assert.match(getResult, /Reinforcement count: 2/);

    const missingConfirm = expectText(await forgetMemoryTool.execute({
      id: createdId,
      confirm: false,
    }));
    assert.match(missingConfirm, /confirm=true/);

    const forgetResult = expectText(await forgetMemoryTool.execute({
      id: createdId,
      confirm: true,
      reason: "User changed their preference.",
    }));
    assert.match(forgetResult, /Forgot memory\./);

    const getForgotten = expectText(await memoryGetTool.execute({
      id: createdId,
    }));
    assert.match(getForgotten, /Status: forgotten/);

    const searchAfterForget = expectText(await memorySearchTool.execute({
      query: "How should you answer the user?",
    }));
    assert.match(searchAfterForget, /No memory results found/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
  }
});

test("project_overview summarizes repo structure and scripts", async () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, "apps", "web"), { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "demo-root",
      packageManager: "pnpm@10.0.0",
      scripts: { dev: "vite", test: "vitest" },
      workspaces: ["apps/*", "packages/*"],
    }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "apps", "web", "package.json"),
    JSON.stringify({ name: "@demo/web" }),
    "utf8",
  );
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");

  const result = expectText(await projectOverviewTool.execute({ path: dir }));

  assert.match(result, /Path:/);
  assert.match(result, /Project markers: .*pnpm-workspace\.yaml/);
  assert.match(result, /Root package: demo-root/);
  assert.match(result, /Package manager: pnpm@10\.0\.0/);
  assert.match(result, /Root scripts: dev, test/);
  assert.match(result, /Workspace packages:\n- @demo\/web \(apps\/web\)/);
});

test("playwright-browser skill documents accessibility-tree workflow and auth patterns", () => {
  const skill = skillManager.loadSkill("playwright-browser");
  assert.ok(skill, "playwright-browser skill must exist");
  assert.match(skill!.body, /browser_navigate/);
  assert.match(skill!.body, /browser_snapshot/);
  assert.match(skill!.body, /browser_fill_form/);
  assert.match(skill!.body, /accessibility tree/i);
  assert.deepEqual(skill!.roles, ["coordinator", "advisor", "director", "inspector"]);
  // Auth flow pattern documented
  assert.match(skill!.body, /browser_fill_form.*fields/is);
});

test("project-scaffold skill teaches small roles to scaffold then hand off", () => {
  const skill = skillManager.loadSkill("project-scaffold");
  assert.ok(skill, "project-scaffold skill must exist");
  assert.deepEqual(skill!.roles, ["coordinator", "ops"]);
  assert.deepEqual(skill!.tools, ["mcp__scaffold__list_templates", "mcp__scaffold__scaffold_project"]);
  assert.match(skill!.body, /scaffold_project/);
  assert.match(skill!.body, /hand off to `director`/i);
});

test("memory-tools skill teaches save, search, inspect, and forget workflow", () => {
  const skill = skillManager.loadSkill("memory-tools");
  assert.ok(skill, "memory-tools skill must exist");
  assert.deepEqual(skill!.roles, ["coordinator", "advisor", "director", "inspector"]);
  assert.deepEqual(skill!.tools, ["save_memory", "memory_search", "memory_get", "forget_memory"]);
  assert.match(skill!.body, /memory_search/);
  assert.match(skill!.body, /forget_memory/);
});

test("ops cleanup skill exists and generic file skill excludes ops", () => {
  const opsSkill = skillManager.loadSkill("ops-file-cleanup");
  const filesSkill = skillManager.loadSkill("files");
  assert.ok(opsSkill, "ops-file-cleanup skill must exist");
  assert.ok(filesSkill, "files skill must exist");
  assert.deepEqual(opsSkill!.roles, ["ops"]);
  assert.match(opsSkill!.body, /delete_file/);
  assert.deepEqual(filesSkill!.roles, ["coordinator", "advisor", "director", "inspector"]);
});

test("team orchestration skill is available to dispatch even without active tools", () => {
  const skill = skillManager.loadSkill("team-orchestration");
  assert.ok(skill, "team-orchestration skill must exist");
  assert.match(skill!.body, /Handoff rules/i);
  assert.deepEqual(skill!.roles, ["dispatch", "coordinator", "advisor", "director", "inspector", "ops"]);

  const prompt = getToolSystemPrompt([], "dispatch");
  assert.match(prompt, /## Workflow/);
  assert.match(prompt, /Team Orchestration/);
  assert.match(prompt, /Loop Prevention/);
});

test("handoff tool enforces the structured message contract and single registration", async () => {
  const handler = createToolHandler();
  const invalid = expectText(await handler.onToolCall("handoff", {
    role: "director",
    message: "TODO: fix the bug",
  }));
  assert.match(invalid, /GOAL, DONE, FILES, NOTES sections/i);

  const message = [
    "GOAL: ship the fix",
    "DONE: reproduced the issue and scoped the root cause",
    "TODO: patch the failing code path",
    "FILES: apps/server/src/index.ts",
    "NOTES: run the targeted tests after the edit",
  ].join("\n");
  const accepted = expectText(await handler.onToolCall("handoff", {
    role: "director",
    message,
  }));
  assert.match(accepted, /Handoff to director registered/);

  const duplicate = expectText(await handler.onToolCall("handoff", {
    role: "inspector",
    message,
  }));
  assert.match(duplicate, /already registered/i);
});

test("compact coordinator tool selection keeps scaffold MCP tools reachable", () => {
  registerMcpTools([
    {
      tool: makeNoopTool(
        "mcp__scaffold__list_templates",
        "List available starter templates for new projects.",
      ),
      roles: ["coordinator"],
    },
    {
      tool: makeNoopTool(
        "mcp__scaffold__scaffold_project",
        "Scaffold a new project from a selected template.",
      ),
      roles: ["coordinator"],
    },
    {
      tool: makeNoopTool(
        "mcp__scaffold__post_setup",
        "Write the follow-up handoff and setup notes after scaffolding.",
      ),
      roles: ["coordinator"],
    },
  ]);

  const tools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "Scaffold a new Next.js starter project and set up the handoff notes.",
    conversation: [],
  });
  const toolNames = tools.map((tool) => tool.name);

  assert.ok(toolNames.includes("mcp__scaffold__list_templates"));
  assert.ok(toolNames.includes("mcp__scaffold__scaffold_project"));
  assert.ok(toolNames.includes("mcp__scaffold__post_setup"));
});

test("tool schemas expose small-model-friendly aliases; skills inject correctly by role", () => {
  assert.ok("file" in (readFileTool.definition.inputSchema.properties ?? {}));
  assert.ok("text" in (searchFilesTool.definition.inputSchema.properties ?? {}));
  assert.ok("literal" in (searchFilesTool.definition.inputSchema.properties ?? {}));
  assert.ok("json" in (httpRequestTool.definition.inputSchema.properties ?? {}));
  assert.ok("action" in (terminalTool.definition.inputSchema.properties ?? {}));

  // Fake a playwright MCP tool definition to trigger playwright-browser + browser-small-model skills
  const playwrightNavTool: import("@ember/core").ToolDefinition = {
    name: "mcp__playwright__browser_navigate",
    description: "Navigate to a URL",
    inputSchema: { type: "object", properties: {} },
  };
  const scaffoldTool: import("@ember/core").ToolDefinition = {
    name: "mcp__scaffold__scaffold_project",
    description: "Create a project from a curated template",
    inputSchema: { type: "object", properties: {} },
  };
  const scaffoldListTool: import("@ember/core").ToolDefinition = {
    name: "mcp__scaffold__list_templates",
    description: "List scaffold templates",
    inputSchema: { type: "object", properties: {} },
  };
  const memorySearchDefinition = memorySearchTool.definition;
  const memoryGetDefinition = memoryGetTool.definition;
  const saveMemoryDefinition = saveMemoryTool.definition;
  const forgetMemoryDefinition = forgetMemoryTool.definition;

  // Without a role: tool-gated skills fire, role-scoped skills do not
  const promptNoRole = getToolSystemPrompt([
    playwrightNavTool,
    scaffoldTool,
    scaffoldListTool,
    memorySearchDefinition,
    memoryGetDefinition,
    saveMemoryDefinition,
    forgetMemoryDefinition,
    parallelTasksTool.definition,
    readFileTool.definition,
    searchFilesTool.definition,
    httpRequestTool.definition,
    terminalTool.definition,
  ]);

  // playwright-browser skill body injected (gated on mcp__playwright__browser_navigate)
  assert.match(promptNoRole, /Playwright Browser Tools/i);
  assert.match(promptNoRole, /browser_snapshot/);
  // Workflow hint for playwright present
  assert.match(promptNoRole, /navigate.*snapshot/i);
  // Scaffold workflow hint present
  assert.match(promptNoRole, /list_templates.*scaffold_project.*director/i);
  // Memory workflow hints present
  assert.match(promptNoRole, /memory_search first, then memory_get/i);
  assert.match(promptNoRole, /Use save_memory only for durable facts/i);
  assert.match(promptNoRole, /Parallel Subtasks/);

  // With a coordinator role, role-scoped skills are also injected
  const promptWithRole = getToolSystemPrompt(
    [
      playwrightNavTool,
      scaffoldTool,
      scaffoldListTool,
      memorySearchDefinition,
      memoryGetDefinition,
      saveMemoryDefinition,
      forgetMemoryDefinition,
      parallelTasksTool.definition,
      readFileTool.definition,
      searchFilesTool.definition,
      httpRequestTool.definition,
      terminalTool.definition,
    ],
    "coordinator",
  );

  // Role-scoped skills injected for coordinator
  assert.match(promptWithRole, /Loop Prevention/);
  // browser-small-model injected (coordinator + mcp__playwright__browser_navigate active)
  assert.match(promptWithRole, /snapshot-first loop/i);
  // coordinator-behavior skill injected
  assert.match(promptWithRole, /Coordinator Extended Behavior/);
  // project-scaffold skill injected for coordinator
  assert.match(promptWithRole, /Project Scaffolding/);
  assert.match(promptWithRole, /curated templates/);
  // memory-tools skill injected for coordinator
  assert.match(promptWithRole, /## Memory Tools/);
  assert.match(promptWithRole, /forget_memory/);

  const promptForOps = getToolSystemPrompt(
    [
      editFileTool.definition,
      deleteFileTool.definition,
    ],
    "ops",
  );
  assert.match(promptForOps, /Ops File Cleanup/);
  assert.doesNotMatch(promptForOps, /### `read_file`/);
});

test("compact coordinator tool prompt stays much shorter for small-model execution", () => {
  const playwrightNavTool: import("@ember/core").ToolDefinition = {
    name: "mcp__playwright__browser_navigate",
    description: "Navigate to a URL",
    inputSchema: { type: "object", properties: {} },
  };

  const fullPrompt = getToolSystemPrompt(
    [
      playwrightNavTool,
      memorySearchTool.definition,
      memoryGetTool.definition,
      saveMemoryTool.definition,
      forgetMemoryTool.definition,
      readFileTool.definition,
      searchFilesTool.definition,
      httpRequestTool.definition,
      terminalTool.definition,
    ],
    "coordinator",
  );
  const compactPrompt = getToolSystemPrompt(
    [
      playwrightNavTool,
      memorySearchTool.definition,
      memoryGetTool.definition,
      saveMemoryTool.definition,
      forgetMemoryTool.definition,
      readFileTool.definition,
      searchFilesTool.definition,
      httpRequestTool.definition,
      terminalTool.definition,
    ],
    "coordinator",
    { compact: true },
  );

  assert.match(compactPrompt, /## Active Skills/);
  assert.match(compactPrompt, /browser-small-model: Supplementary Playwright browser guidance/i);
  assert.ok(compactPrompt.length < fullPrompt.length / 2);
  assert.doesNotMatch(compactPrompt, /## Playwright Browser — Small-Model Rules/);
});

test("compact coordinator tool selection keeps only tools relevant to the current task", () => {
  const codeTools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "Fix the TypeScript build in this repo and edit the failing file.",
    conversation: [],
  });
  const codeToolNames = new Set(codeTools.map((tool) => tool.name));
  assert.ok(codeToolNames.has("project_overview"));
  assert.ok(codeToolNames.has("search_files"));
  assert.ok(codeToolNames.has("read_file"));
  assert.ok(codeToolNames.has("edit_file"));
  assert.ok(codeToolNames.has("run_terminal_command"));
  assert.equal(codeToolNames.has("save_memory"), false);

  const webTools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "Search the latest docs and fetch the relevant page.",
    conversation: [],
  });
  const webToolNames = new Set(webTools.map((tool) => tool.name));
  assert.ok(webToolNames.has("web_search"));
  assert.ok(webToolNames.has("fetch_page"));
  assert.ok(webToolNames.has("http_request"));
  assert.equal(webToolNames.has("project_overview"), false);
  assert.equal(webToolNames.has("search_files"), false);
  assert.equal(webToolNames.has("read_file"), false);
  assert.equal(webToolNames.has("memory_search"), false);
  assert.equal(webToolNames.has("edit_file"), false);
  assert.equal(webToolNames.has("run_terminal_command"), false);

  const recallTools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "What do you remember from our earlier chats about my project preferences?",
    conversation: [],
  });
  const recallToolNames = new Set(recallTools.map((tool) => tool.name));
  assert.ok(recallToolNames.has("memory_search"));
  assert.ok(recallToolNames.has("memory_get"));
  assert.equal(recallToolNames.has("project_overview"), false);
});

test("compact coordinator tool definitions are trimmed for small local models", () => {
  const compactTools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "Fix the TypeScript build in this repo and edit the failing file.",
    conversation: [],
  });
  const terminalDefinition = compactTools.find((tool) => tool.name === "run_terminal_command");
  assert.ok(terminalDefinition);
  assert.ok(terminalDefinition!.description.length < terminalTool.definition.description.length);

  const compactCommandProperty = terminalDefinition!.inputSchema.properties?.command as
    | { description?: string }
    | undefined;
  const fullCommandProperty = terminalTool.definition.inputSchema.properties?.command as
    | { description?: string }
    | undefined;
  assert.ok(compactCommandProperty?.description);
  assert.ok(fullCommandProperty?.description);
  assert.ok(compactCommandProperty!.description!.length < fullCommandProperty!.description!.length);
});

test("git_inspect reports status and diff stats", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "tracked.txt"), "one\n", "utf8");

  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Ember Test"]);
  runGit(dir, ["config", "user.email", "ember@example.test"]);
  runGit(dir, ["add", "tracked.txt"]);
  runGit(dir, ["commit", "-m", "initial"]);

  writeFileSync(path.join(dir, "tracked.txt"), "one\ntwo\n", "utf8");

  const status = expectText(await gitInspectTool.execute({ action: "status", path: dir }));
  const diffStats = expectText(await gitInspectTool.execute({ action: "diff_stats", path: dir }));

  assert.match(status, /Action: status/);
  assert.match(status, /M tracked\.txt/);
  assert.match(diffStats, /Action: diff_stats/);
  assert.match(diffStats, /tracked\.txt \| 1 \+/);
});

test("replaceMcpTools swaps stale MCP registrations out of the compact registry", () => {
  replaceMcpTools([
    {
      tool: makeNoopTool(
        "mcp__alpha__search_docs",
        "Search docs from the alpha MCP server.",
      ),
      roles: ["coordinator"],
    },
  ]);

  let toolNames = new Set(
    getExecutionToolsForRole("coordinator", {
      compact: false,
    }).map((tool) => tool.name),
  );
  assert.ok(toolNames.has("mcp__alpha__search_docs"));

  replaceMcpTools([
    {
      tool: makeNoopTool(
        "mcp__beta__search_docs",
        "Search docs from the beta MCP server.",
      ),
      roles: ["coordinator"],
    },
  ]);

  toolNames = new Set(
    getExecutionToolsForRole("coordinator", {
      compact: false,
    }).map((tool) => tool.name),
  );
  assert.equal(toolNames.has("mcp__alpha__search_docs"), false);
  assert.ok(toolNames.has("mcp__beta__search_docs"));

  replaceMcpTools([]);
});

test("request-scoped tool snapshots survive global MCP registry replacement", async () => {
  const staleTool: EmberTool = {
    definition: {
      name: "mcp__snapshot__inspect",
      description: "Old snapshot tool",
      inputSchema: { type: "object", properties: {} },
    },
    execute: async () => "stale-result",
  };
  const handler = createToolHandler({
    toolSnapshot: new Map([[staleTool.definition.name, staleTool]]),
  });

  replaceMcpTools([
    {
      tool: makeNoopTool("mcp__snapshot__inspect", "Replacement tool"),
      roles: ["coordinator"],
    },
  ]);

  const result = expectText(await handler.onToolCall("mcp__snapshot__inspect", {}));
  assert.equal(result, "stale-result");

  replaceMcpTools([]);
});
