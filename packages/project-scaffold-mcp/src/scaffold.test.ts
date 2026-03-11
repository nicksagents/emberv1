import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getTemplateOptions, listTemplates, postSetup, scaffoldProject } from "./scaffold.js";

function tempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "project-scaffold-"));
}

test("list_templates exposes curated templates", () => {
  const result = listTemplates({});
  assert.match(result, /nextjs-app/);
  assert.match(result, /python-fastapi/);
  assert.match(result, /typescript-library/);
});

test("get_template_options exposes defaults and director guidance", () => {
  const result = getTemplateOptions("nextjs-app");
  assert.match(result, /Defaults:/);
  assert.match(result, /Director focus after scaffold:/);
  assert.match(result, /src\/app\/page\.tsx/);
});

test("scaffold_project renders files and metadata for nextjs template", () => {
  const workspace = tempWorkspace();
  const previousCwd = process.cwd();
  process.chdir(workspace);

  try {
    const result = scaffoldProject({
      templateId: "nextjs-app",
      targetDir: "demo-app",
      projectName: "Demo App",
      answers: { app_title: "Demo Control Room" },
    });

    assert.match(result, /Scaffolded nextjs-app/);
    assert.match(result, /DIRECTOR_HANDOFF.md/);

    const page = readFileSync(path.join(workspace, "demo-app", "src", "app", "page.tsx"), "utf8");
    const agents = readFileSync(path.join(workspace, "demo-app", "AGENTS.md"), "utf8");
    const metadata = readFileSync(path.join(workspace, "demo-app", ".ember", "scaffold", "project-scaffold.json"), "utf8");

    assert.match(page, /Demo Control Room/);
    assert.match(agents, /Next\.js 15 App Router/);
    assert.match(metadata, /"templateId": "nextjs-app"/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("post_setup writes director handoff and checklist", () => {
  const workspace = tempWorkspace();
  const previousCwd = process.cwd();
  process.chdir(workspace);

  try {
    scaffoldProject({
      templateId: "rust-cli",
      targetDir: "ferris-cli",
      projectName: "Ferris CLI",
    });

    const result = postSetup({ targetDir: "ferris-cli" });
    assert.match(result, /Post-setup completed/);
    assert.ok(existsSync(path.join(workspace, "ferris-cli", "DIRECTOR_HANDOFF.md")));
    assert.ok(existsSync(path.join(workspace, "ferris-cli", "TODO.scaffold.md")));
  } finally {
    process.chdir(previousCwd);
  }
});
