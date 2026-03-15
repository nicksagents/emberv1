import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { isNodeSqliteAvailable } from "@ember/core";
import { skillManager } from "@ember/core/skills";

// Point the SkillManager at the bundled skills directory so skill injection
// works in tests exactly as it does at runtime.
const __testDir = dirname(fileURLToPath(import.meta.url));
skillManager.initialize({
  bundledDir: join(__testDir, "..", "..", "..", "skills"),
});

import { deleteFileTool, editFileTool, listDirectoryTool, readFileTool, statPathTool, writeFileTool } from "./tools/files.js";
import { credentialGetTool, credentialListTool, credentialSaveTool } from "./tools/credentials.js";
import { resetMockCredentialSecretStore } from "./tools/credential-secret-store.js";
import { fetchPageTool } from "./tools/fetch-page.js";
import { gitInspectTool } from "./tools/git-inspect.js";
import { httpRequestTool } from "./tools/http-request.js";
import { forgetMemoryTool, memoryGetTool, memorySearchTool, saveMemoryTool } from "./tools/memory.js";
import { parallelTasksTool } from "./tools/parallel-tasks.js";
import { projectOverviewTool } from "./tools/project-overview.js";
import { searchFilesFallback, searchFilesTool } from "./tools/search-files.js";
import { sshExecuteTool } from "./tools/ssh-execute.js";
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

function canRunGitFixtures(): boolean {
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
  });
  return !result.error && result.status === 0;
}

const sqliteTest = isNodeSqliteAvailable() ? test : test.skip;
const gitFixtureTest = canRunGitFixtures() ? test : test.skip;

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

test("stat_path reports type, size, and timestamps", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "meta.txt");
  writeFileSync(filePath, "hello", "utf8");

  const result = expectText(await statPathTool.execute({
    path: filePath,
  }));

  assert.match(result, /Path:/);
  assert.match(result, /Type: file/);
  assert.match(result, /Size: 5 bytes/);
  assert.match(result, /Modified:/);
  assert.match(result, /Extension: \.txt/);
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

test("ssh_execute validates host safety and required inputs", async () => {
  const missingHost = expectText(await sshExecuteTool.execute({
    action: "run",
    username: "pi",
    command: "uname -a",
  }));
  assert.match(missingHost, /host is required/i);

  const publicHostBlocked = expectText(await sshExecuteTool.execute({
    action: "run",
    host: "8.8.8.8",
    username: "pi",
    password: "demo-password",
    command: "uname -a",
  }));
  assert.match(publicHostBlocked, /private LAN\/Tailscale range/i);

  const missingAuth = expectText(await sshExecuteTool.execute({
    action: "run",
    host: "192.168.1.20",
    username: "pi",
    command: "uname -a",
  }));
  assert.match(missingAuth, /provide one auth method/i);

  const missingCommand = expectText(await sshExecuteTool.execute({
    action: "run",
    host: "192.168.1.20",
    username: "pi",
    password: "demo-password",
  }));
  assert.match(missingCommand, /command is required/i);

  const invalidHostKeyPolicy = expectText(await sshExecuteTool.execute({
    action: "run",
    host: "192.168.1.20",
    username: "pi",
    password: "demo-password",
    command: "echo ok",
    host_key_policy: "invalid",
  }));
  assert.match(invalidHostKeyPolicy, /host_key_policy/i);
});

sqliteTest("memory tools can save, search, inspect, and forget memories", async () => {
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

test("credential vault skill teaches local-only login reuse", () => {
  const skill = skillManager.loadSkill("credential-vault");
  assert.ok(skill, "credential-vault skill must exist");
  assert.deepEqual(skill!.roles, ["coordinator", "advisor", "director", "inspector"]);
  assert.deepEqual(skill!.tools, ["credential_save", "credential_list", "credential_get"]);
  assert.match(skill!.body, /local-only/i);
  assert.match(skill!.body, /save_memory/i);
});

test("ssh-remote skill teaches SSH test-first workflow", () => {
  const skill = skillManager.loadSkill("ssh-remote");
  assert.ok(skill, "ssh-remote skill must exist");
  assert.deepEqual(skill!.roles, ["coordinator", "advisor", "director", "inspector"]);
  assert.deepEqual(skill!.tools, ["ssh_execute", "credential_list", "credential_get", "network_tools"]);
  assert.match(skill!.body, /ssh_execute action=test/i);
  assert.match(skill!.body, /private-network\/Tailscale hosts only/i);
});

test("desktop-small-model skill enforces screenshot-first verification", () => {
  const skill = skillManager.loadSkill("desktop-small-model");
  assert.ok(skill, "desktop-small-model skill must exist");
  assert.deepEqual(skill!.roles, ["coordinator", "advisor", "director", "inspector"]);
  assert.deepEqual(skill!.tools, ["mcp__desktop__describe_environment", "mcp__desktop__take_screenshot"]);
  assert.match(skill!.body, /describe_environment -> get_active_window\/list_windows -> take_screenshot -> OCR text search/i);
  assert.match(skill!.body, /one action/i);
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

test("compact coordinator tool selection keeps desktop window tools reachable", () => {
  registerMcpTools([
    {
      tool: makeNoopTool(
        "mcp__desktop__describe_environment",
        "Describe desktop automation capabilities.",
      ),
      roles: ["coordinator"],
    },
    {
      tool: makeNoopTool(
        "mcp__desktop__get_active_window",
        "Get the currently focused window.",
      ),
      roles: ["coordinator"],
    },
    {
      tool: makeNoopTool(
        "mcp__desktop__list_windows",
        "List visible desktop windows.",
      ),
      roles: ["coordinator"],
    },
    {
      tool: makeNoopTool(
        "mcp__desktop__take_screenshot",
        "Take a desktop screenshot.",
      ),
      roles: ["coordinator"],
    },
    {
      tool: makeNoopTool(
        "mcp__desktop__find_text_on_screen",
        "Find visible text on the screen.",
      ),
      roles: ["coordinator"],
    },
    {
      tool: makeNoopTool(
        "mcp__desktop__drag_mouse",
        "Drag the mouse between two screen coordinates.",
      ),
      roles: ["coordinator"],
    },
    {
      tool: makeNoopTool(
        "mcp__desktop__scroll_mouse",
        "Scroll the mouse wheel.",
      ),
      roles: ["coordinator"],
    },
  ]);

  const tools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "Focus the right desktop window, inspect the active window, use OCR to find the Continue button, then drag and scroll if needed and verify with a screenshot.",
    conversation: [],
  });
  const toolNames = tools.map((tool) => tool.name);

  assert.ok(toolNames.includes("mcp__desktop__describe_environment"));
  assert.ok(toolNames.includes("mcp__desktop__get_active_window"));
  assert.ok(toolNames.includes("mcp__desktop__list_windows"));
  assert.ok(toolNames.includes("mcp__desktop__take_screenshot"));
  assert.ok(toolNames.includes("mcp__desktop__find_text_on_screen"));
  assert.ok(toolNames.includes("mcp__desktop__drag_mouse"));
  assert.ok(toolNames.includes("mcp__desktop__scroll_mouse"));

  replaceMcpTools([]);
});

test("tool schemas expose small-model-friendly aliases; skills inject correctly by role", () => {
  assert.ok("file" in (readFileTool.definition.inputSchema.properties ?? {}));
  assert.ok("text" in (searchFilesTool.definition.inputSchema.properties ?? {}));
  assert.ok("literal" in (searchFilesTool.definition.inputSchema.properties ?? {}));
  assert.ok("json" in (httpRequestTool.definition.inputSchema.properties ?? {}));
  assert.ok("action" in (terminalTool.definition.inputSchema.properties ?? {}));
  assert.ok("ip" in (sshExecuteTool.definition.inputSchema.properties ?? {}));
  assert.ok("user" in (sshExecuteTool.definition.inputSchema.properties ?? {}));

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
  const desktopDescribeTool: import("@ember/core").ToolDefinition = {
    name: "mcp__desktop__describe_environment",
    description: "Describe desktop automation capabilities.",
    inputSchema: { type: "object", properties: {} },
  };
  const desktopScreenshotTool: import("@ember/core").ToolDefinition = {
    name: "mcp__desktop__take_screenshot",
    description: "Take a desktop screenshot.",
    inputSchema: { type: "object", properties: {} },
  };
  const memorySearchDefinition = memorySearchTool.definition;
  const memoryGetDefinition = memoryGetTool.definition;
  const saveMemoryDefinition = saveMemoryTool.definition;
  const forgetMemoryDefinition = forgetMemoryTool.definition;
  const credentialSaveDefinition = credentialSaveTool.definition;
  const credentialListDefinition = credentialListTool.definition;
  const credentialGetDefinition = credentialGetTool.definition;

  // Without a role: tool-gated skills fire, role-scoped skills do not
  const promptNoRole = getToolSystemPrompt([
    playwrightNavTool,
    scaffoldTool,
    scaffoldListTool,
    desktopDescribeTool,
    desktopScreenshotTool,
    sshExecuteTool.definition,
    credentialSaveDefinition,
    credentialListDefinition,
    credentialGetDefinition,
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
  // Credential workflow hints present
  assert.match(promptNoRole, /credential_list.*credential_get/i);
  assert.match(promptNoRole, /credential_save.*save_memory/i);
  // SSH workflow hint + skill body present
  assert.match(promptNoRole, /ssh_execute action=test.*action=run/i);
  assert.match(promptNoRole, /SSH Remote Control/);
  // Memory workflow hints present
  assert.match(promptNoRole, /memory_search first, then memory_get/i);
  assert.match(promptNoRole, /Use save_memory only for durable facts/i);
  assert.match(promptNoRole, /Parallel Subtasks/);
  assert.match(promptNoRole, /host machine/i);

  // With a coordinator role, role-scoped skills are also injected
  const promptWithRole = getToolSystemPrompt(
    [
      playwrightNavTool,
      scaffoldTool,
      scaffoldListTool,
      desktopDescribeTool,
      desktopScreenshotTool,
      sshExecuteTool.definition,
      credentialSaveDefinition,
      credentialListDefinition,
      credentialGetDefinition,
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
  // credential-vault skill injected for coordinator
  assert.match(promptWithRole, /## Credential Vault/);
  assert.match(promptWithRole, /credential_get/);
  // memory-tools skill injected for coordinator
  assert.match(promptWithRole, /## Memory Tools/);
  assert.match(promptWithRole, /forget_memory/);
  // desktop-small-model skill injected for coordinator
  assert.match(promptWithRole, /Desktop Automation — Small-Model Rules/);
  assert.match(promptWithRole, /host machine/i);

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

test("compact coordinator tool selection keeps stat_path for filesystem inspection tasks", () => {
  const tools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "Check whether this path exists, whether it is a file or directory, and inspect its size before editing.",
    conversation: [],
  });
  const toolNames = new Set(tools.map((tool) => tool.name));

  assert.ok(toolNames.has("stat_path"));
  assert.ok(toolNames.has("read_file"));
});

test("compact coordinator tool selection keeps host filesystem tools for Desktop listing tasks", () => {
  const tools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "List off the items in my Desktop folder.",
    conversation: [],
  });
  const toolNames = new Set(tools.map((tool) => tool.name));

  assert.ok(toolNames.has("list_directory"));
  assert.ok(toolNames.has("stat_path"));
  assert.equal(toolNames.has("project_overview"), false);
  assert.equal(toolNames.has("git_inspect"), false);
});

test("compact coordinator tool selection keeps credential tools for login tasks", () => {
  const tools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "Sign in to Gmail with the saved password and email.",
    conversation: [],
  });
  const toolNames = new Set(tools.map((tool) => tool.name));

  assert.ok(toolNames.has("credential_list"));
  assert.ok(toolNames.has("credential_get"));
  assert.ok(toolNames.has("fetch_page"));
  assert.ok(toolNames.has("http_request"));
});

test("compact coordinator tool selection keeps ssh tools for remote host tasks", () => {
  const tools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "SSH into my Tailscale host and run systemctl status nginx using saved credentials.",
    conversation: [],
  });
  const toolNames = new Set(tools.map((tool) => tool.name));

  assert.ok(toolNames.has("ssh_execute"));
  assert.ok(toolNames.has("network_tools"));
  assert.ok(toolNames.has("credential_list"));
  assert.ok(toolNames.has("credential_get"));
});

test("compact coordinator tool selection stays minimal for casual greetings", () => {
  const tools = getExecutionToolsForRole("coordinator", {
    compact: true,
    content: "hey",
    conversation: [],
  });

  assert.deepEqual(tools.map((tool) => tool.name), ["handoff"]);
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

test("terminal tool can report session status, list sessions, and close a session", async () => {
  const sessionKey = "terminal-test";
  const runResult = expectText(await terminalTool.execute({
    __sessionKey: sessionKey,
    command: "printf 'hello'",
    timeout_ms: 5_000,
  }));
  assert.equal(runResult, "hello");

  const statusResult = expectText(await terminalTool.execute({
    __sessionKey: sessionKey,
    session_action: "status",
  }));
  assert.match(statusResult, /Session: terminal-test/);
  assert.match(statusResult, /Commands run: 1/);
  assert.match(statusResult, /Last command: printf 'hello'/);

  const listResult = expectText(await terminalTool.execute({
    session_action: "list_sessions",
  }));
  assert.match(listResult, /terminal-test/);

  const closeResult = expectText(await terminalTool.execute({
    __sessionKey: sessionKey,
    session_action: "close",
  }));
  assert.match(closeResult, /has been closed/);
});

test("credential tools store secrets locally while redacting memory observations", async () => {
  const dir = tempDir();
  const previousRoot = process.env.EMBER_ROOT;
  const previousBackend = process.env.EMBER_CREDENTIAL_SECRET_BACKEND;
  process.env.EMBER_ROOT = dir;
  process.env.EMBER_CREDENTIAL_SECRET_BACKEND = "mock";
  resetMockCredentialSecretStore();

  try {
    const saveResult = expectText(await credentialSaveTool.execute({
      label: "Gmail",
      target: "mail.google.com",
      email: "demo@example.com",
      password: "super-secret-password",
      login_url: "https://accounts.google.com",
    }));
    assert.match(saveResult, /Saved credential vault entry using Mock keychain/);
    assert.doesNotMatch(saveResult, /super-secret-password/);

    const listResult = expectText(await credentialListTool.execute({ query: "gmail" }));
    assert.match(listResult, /Credential vault entries/);
    assert.doesNotMatch(listResult, /super-secret-password/);
    assert.match(listResult, /fields=email,password,login_url/);

    const rawVault = expectText(await readFileTool.execute({ path: path.join(dir, "data", "credential-vault.json") }));
    assert.doesNotMatch(rawVault, /super-secret-password/);
    assert.match(rawVault, /"secretBackend": "mock"/);

    const observations: import("@ember/core").MemoryToolObservation[] = [];
    const handler = createToolHandler({
      onToolResult(observation) {
        observations.push(observation);
      },
    });

    const getResult = expectText(await handler.onToolCall("credential_get", { label: "Gmail" }));
    assert.match(getResult, /Password: super-secret-password/);
    assert.equal(observations.length, 1);
    assert.doesNotMatch(observations[0]?.resultText ?? "", /super-secret-password/);
    assert.match(observations[0]?.resultText ?? "", /omitted from memory traces/i);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.EMBER_ROOT;
    } else {
      process.env.EMBER_ROOT = previousRoot;
    }
    if (previousBackend === undefined) {
      delete process.env.EMBER_CREDENTIAL_SECRET_BACKEND;
    } else {
      process.env.EMBER_CREDENTIAL_SECRET_BACKEND = previousBackend;
    }
    resetMockCredentialSecretStore();
  }
});

test("save_memory rejects credential-like content", async () => {
  const result = expectText(await saveMemoryTool.execute({
    content: "The Gmail password is super-secret-password.",
    scope: "user",
  }));

  assert.match(result, /must not be stored with save_memory/i);
});

gitFixtureTest("git_inspect reports status and diff stats", async (t) => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "tracked.txt"), "one\n", "utf8");

  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Ember Test"]);
  runGit(dir, ["config", "user.email", "ember@example.test"]);
  runGit(dir, ["add", "tracked.txt"]);
  runGit(dir, ["commit", "-m", "initial"]);

  writeFileSync(path.join(dir, "tracked.txt"), "one\ntwo\n", "utf8");

  const status = expectText(await gitInspectTool.execute({ action: "status", path: dir }));
  if (/not inside a git repository or git is unavailable/i.test(status)) {
    t.skip("Skipping git_inspect test because git commands are unavailable in this runtime.");
    return;
  }
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
