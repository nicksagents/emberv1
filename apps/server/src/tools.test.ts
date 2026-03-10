import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { browserTool } from "./tools/browser.js";
import { editFileTool, listDirectoryTool, readFileTool, writeFileTool } from "./tools/files.js";
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

test("browser tool supports snapshot ids and semantic fill hints for auth forms", () => {
  const properties = browserTool.definition.inputSchema.properties;

  assert.ok("element_id" in properties);
  assert.ok("label" in properties);
  assert.ok("placeholder" in properties);
  assert.ok("name" in properties);
  assert.match(properties.action.description, /snapshot/);
  assert.match(properties.action.description, /auth_snapshot/);
  assert.match(properties.action.description, /auth_fill_email/);
  assert.match(properties.action.description, /submit_form/);
  assert.match(browserTool.systemPrompt, /snapshot to get a compact page map/i);
  assert.match(browserTool.systemPrompt, /element_id/);
  assert.match(browserTool.systemPrompt, /open_sign_in, auth_snapshot, auth_fill_email, auth_fill_code, and submit_form/i);
  assert.match(browserTool.systemPrompt, /one-time code \/ OTP widgets/i);
});

test("tool schemas expose small-model-friendly aliases and defaults", () => {
  assert.ok("file" in readFileTool.definition.inputSchema.properties);
  assert.ok("text" in searchFilesTool.definition.inputSchema.properties);
  assert.ok("literal" in searchFilesTool.definition.inputSchema.properties);
  assert.ok("json" in httpRequestTool.definition.inputSchema.properties);
  assert.ok("action" in terminalTool.definition.inputSchema.properties);

  const prompt = getToolSystemPrompt([
    browserTool.definition,
    readFileTool.definition,
    searchFilesTool.definition,
    httpRequestTool.definition,
    terminalTool.definition,
  ]);

  assert.match(prompt, /Small-Model Defaults/);
  assert.match(prompt, /navigate -> snapshot -> act with element_id -> snapshot/);
  assert.match(prompt, /search_files with literal=true/);
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
