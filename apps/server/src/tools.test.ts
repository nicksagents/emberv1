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
import { projectOverviewTool } from "./tools/project-overview.js";
import { searchFilesFallback, searchFilesTool } from "./tools/search-files.js";
import { getToolSystemPrompt } from "./tools/index.js";
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

test("ops cleanup skill exists and generic file skill excludes ops", () => {
  const opsSkill = skillManager.loadSkill("ops-file-cleanup");
  const filesSkill = skillManager.loadSkill("files");
  assert.ok(opsSkill, "ops-file-cleanup skill must exist");
  assert.ok(filesSkill, "files skill must exist");
  assert.deepEqual(opsSkill!.roles, ["ops"]);
  assert.match(opsSkill!.body, /delete_file/);
  assert.deepEqual(filesSkill!.roles, ["coordinator", "advisor", "director", "inspector"]);
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

  // Without a role: tool-gated skills fire, role-scoped skills do not
  const promptNoRole = getToolSystemPrompt([
    playwrightNavTool,
    scaffoldTool,
    scaffoldListTool,
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

  // With a coordinator role, role-scoped skills are also injected
  const promptWithRole = getToolSystemPrompt(
    [
      playwrightNavTool,
      scaffoldTool,
      scaffoldListTool,
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
