import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScaffoldMetadata, TemplateManifest, TemplateRecord, TemplateScalar } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(__dirname, "..", "templates");
const METADATA_PATH = join(".ember", "scaffold", "project-scaffold.json");

function titleCase(input: string): string {
  return input
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

function pythonModuleName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "app";
}

function constantCase(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "APP";
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      out.push(...walkFiles(fullPath));
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

function renderString(input: string, variables: Record<string, TemplateScalar>): string {
  return input.replace(/{{\s*([\w.]+)\s*}}/g, (_match, key) => {
    const value = variables[key];
    return value === undefined ? "" : String(value);
  });
}

function ensureInsideWorkspace(targetDir: string): string {
  const workspaceRoot = resolve(process.cwd());
  const absolute = resolve(workspaceRoot, targetDir);
  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}/`)) {
    throw new Error(`Target path must stay inside the workspace root: ${workspaceRoot}`);
  }
  return absolute;
}

function directoryIsEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).length === 0;
}

function packageManagerCommands(packageManager: string): Record<string, string> {
  switch (packageManager) {
    case "npm":
      return {
        package_manager_install: "npm install",
        package_manager_run_dev: "npm run dev",
        package_manager_run_build: "npm run build",
        package_manager_run_test: "npm test",
        package_manager_run_start: "npm run start",
      };
    case "yarn":
      return {
        package_manager_install: "yarn install",
        package_manager_run_dev: "yarn dev",
        package_manager_run_build: "yarn build",
        package_manager_run_test: "yarn test",
        package_manager_run_start: "yarn start",
      };
    case "bun":
      return {
        package_manager_install: "bun install",
        package_manager_run_dev: "bun run dev",
        package_manager_run_build: "bun run build",
        package_manager_run_test: "bun test",
        package_manager_run_start: "bun run start",
      };
    case "pnpm":
    default:
      return {
        package_manager_install: "pnpm install",
        package_manager_run_dev: "pnpm dev",
        package_manager_run_build: "pnpm build",
        package_manager_run_test: "pnpm test",
        package_manager_run_start: "pnpm start",
      };
  }
}

function buildVariables(
  manifest: TemplateManifest,
  projectName: string,
  packageManager: string,
  answers: Record<string, TemplateScalar>,
): Record<string, TemplateScalar> {
  const projectSlug = slugify(projectName);
  const merged = {
    ...(manifest.defaults ?? {}),
    ...answers,
  };
  const appTitle = String(merged.app_title ?? titleCase(projectName));
  const packageName = String(merged.package_name ?? projectSlug);
  const moduleName = String(merged.module_name ?? pythonModuleName(projectName));
  const port = Number(merged.port ?? 3000);

  return {
    ...merged,
    ...packageManagerCommands(packageManager),
    project_name: projectName,
    project_slug: projectSlug,
    package_name: packageName,
    package_manager: packageManager,
    app_title: appTitle,
    module_name: moduleName,
    port,
    year: new Date().getUTCFullYear(),
    package_manager_field: `${packageManager}@latest`,
    project_constant: constantCase(projectName),
    template_id: manifest.id,
    template_title: manifest.title,
  };
}

export function loadTemplates(): TemplateRecord[] {
  if (!existsSync(TEMPLATE_ROOT)) {
    throw new Error(`Templates directory missing: ${TEMPLATE_ROOT}`);
  }

  return readdirSync(TEMPLATE_ROOT)
    .map((entry) => {
      const templateDir = join(TEMPLATE_ROOT, entry);
      if (!statSync(templateDir).isDirectory()) return null;
      const manifestPath = join(templateDir, "manifest.json");
      const filesDir = join(templateDir, "files");
      if (!existsSync(manifestPath) || !existsSync(filesDir)) return null;
      return {
        manifest: readJson<TemplateManifest>(manifestPath),
        templateDir,
        filesDir,
      };
    })
    .filter((record): record is TemplateRecord => record !== null)
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

export function getTemplate(templateId: string): TemplateRecord {
  const template = loadTemplates().find((item) => item.manifest.id === templateId);
  if (!template) {
    throw new Error(`Unknown template "${templateId}". Use list_templates first.`);
  }
  return template;
}

export function summarizeTemplate(template: TemplateRecord): string {
  const { manifest } = template;
  const tags = manifest.tags.length ? ` tags=${manifest.tags.join(",")}` : "";
  return `- ${manifest.id} [${manifest.stack}/${manifest.kind}] ${manifest.title}: ${manifest.description}${tags}`;
}

export function listTemplates(filters: {
  stack?: string;
  kind?: string;
  query?: string;
}): string {
  const query = filters.query?.trim().toLowerCase();
  const templates = loadTemplates().filter((template) => {
    if (filters.stack && template.manifest.stack !== filters.stack) return false;
    if (filters.kind && template.manifest.kind !== filters.kind) return false;
    if (!query) return true;
    const haystack = [
      template.manifest.id,
      template.manifest.title,
      template.manifest.description,
      ...template.manifest.tags,
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  if (templates.length === 0) {
    return "No templates matched the filters.";
  }

  return [
    `Templates: ${templates.length}`,
    ...templates.map(summarizeTemplate),
    "",
    "Recommended flow:",
    "1. get_template_options(template_id)",
    "2. scaffold_project(template_id, target_dir, project_name, ...)",
    "3. post_setup(target_dir) to write the director handoff file",
  ].join("\n");
}

export function getTemplateOptions(templateId: string): string {
  const { manifest } = getTemplate(templateId);
  const optionLines = (manifest.options ?? []).map((option) => {
    const required = option.required ? "required" : "optional";
    const enumSuffix = option.enumValues?.length
      ? ` values=${option.enumValues.join("|")}`
      : "";
    const defaultSuffix = option.default !== undefined ? ` default=${String(option.default)}` : "";
    return `- ${option.key} (${option.type}, ${required})${defaultSuffix}${enumSuffix}: ${option.description}`;
  });

  const defaults = Object.entries(manifest.defaults ?? {}).map(
    ([key, value]) => `- ${key}: ${String(value)}`,
  );

  return [
    `${manifest.id} — ${manifest.title}`,
    `${manifest.description}`,
    `Stack: ${manifest.stack}`,
    `Kind: ${manifest.kind}`,
    `Tags: ${manifest.tags.join(", ")}`,
    `Entrypoints: ${(manifest.entrypoints ?? []).join(", ") || "none"}`,
    "",
    "Defaults:",
    ...(defaults.length ? defaults : ["- none"]),
    "",
    "Options:",
    ...(optionLines.length ? optionLines : ["- none"]),
    "",
    "Director focus after scaffold:",
    ...(manifest.directorNotes ?? []).map((note) => `- ${note}`),
  ].join("\n");
}

export function scaffoldProject(input: {
  templateId: string;
  targetDir: string;
  projectName: string;
  packageManager?: string;
  answers?: Record<string, TemplateScalar>;
  overwrite?: boolean;
}): string {
  const template = getTemplate(input.templateId);
  const absoluteTargetDir = ensureInsideWorkspace(input.targetDir);

  if (existsSync(absoluteTargetDir) && !directoryIsEmpty(absoluteTargetDir) && !input.overwrite) {
    throw new Error(`Target directory is not empty: ${absoluteTargetDir}`);
  }

  mkdirSync(absoluteTargetDir, { recursive: true });

  const packageManager = input.packageManager || String(template.manifest.defaults?.package_manager ?? "pnpm");
  const variables = buildVariables(
    template.manifest,
    input.projectName,
    packageManager,
    input.answers ?? {},
  );

  const createdFiles: string[] = [];
  for (const sourcePath of walkFiles(template.filesDir)) {
    const relativeSource = relative(template.filesDir, sourcePath);
    const renderedRelative = renderString(relativeSource, variables);
    const destinationPath = join(absoluteTargetDir, renderedRelative);
    mkdirSync(dirname(destinationPath), { recursive: true });
    const contents = readFileSync(sourcePath, "utf8");
    writeFileSync(destinationPath, renderString(contents, variables), "utf8");
    createdFiles.push(relative(absoluteTargetDir, destinationPath));
  }

  const metadata: ScaffoldMetadata = {
    templateId: template.manifest.id,
    templateTitle: template.manifest.title,
    stack: template.manifest.stack,
    kind: template.manifest.kind,
    targetDir: absoluteTargetDir,
    projectName: input.projectName,
    createdAt: new Date().toISOString(),
    variables,
    entrypoints: template.manifest.entrypoints ?? [],
    directorNotes: template.manifest.directorNotes ?? [],
    setupCommands: (template.manifest.setupCommands ?? []).map((command) => renderString(command, variables)),
    followUpCommands: (template.manifest.followUpCommands ?? []).map((command) => renderString(command, variables)),
  };

  const metadataFile = join(absoluteTargetDir, METADATA_PATH);
  mkdirSync(dirname(metadataFile), { recursive: true });
  writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), "utf8");

  const handoffLines = [
    `Scaffold ready for director.`,
    `- Template: ${metadata.templateId}`,
    `- Target: ${absoluteTargetDir}`,
    `- Stack: ${metadata.stack}/${metadata.kind}`,
    `- Key entrypoints: ${(metadata.entrypoints.length ? metadata.entrypoints : createdFiles.slice(0, 5)).join(", ")}`,
    `- Immediate director goals: ${(metadata.directorNotes.length ? metadata.directorNotes : ["Implement the requested feature set on top of the scaffold."]).join("; ")}`,
  ];

  return [
    `Scaffolded ${template.manifest.id} into ${absoluteTargetDir}`,
    `Created files: ${createdFiles.length}`,
    `Conventions included: AGENTS.md, .ember/skills/project-stack/SKILL.md`,
    "",
    "Recommended setup commands:",
    ...(metadata.setupCommands.length ? metadata.setupCommands.map((command) => `- ${command}`) : ["- none"]),
    "",
    "Recommended follow-up commands:",
    ...(metadata.followUpCommands.length ? metadata.followUpCommands.map((command) => `- ${command}`) : ["- none"]),
    "",
    "Director handoff summary:",
    ...handoffLines,
    "",
    `Run post_setup with target_dir="${input.targetDir}" to write DIRECTOR_HANDOFF.md.`,
  ].join("\n");
}

export function postSetup(input: {
  targetDir: string;
  writeDirectorHandoff?: boolean;
  writeScaffoldTodo?: boolean;
}): string {
  const absoluteTargetDir = ensureInsideWorkspace(input.targetDir);
  const metadataFile = join(absoluteTargetDir, METADATA_PATH);
  if (!existsSync(metadataFile)) {
    throw new Error(`No scaffold metadata found at ${metadataFile}. Run scaffold_project first.`);
  }

  const metadata = readJson<ScaffoldMetadata>(metadataFile);
  const wrote: string[] = [];

  if (input.writeDirectorHandoff !== false) {
    const handoffPath = join(absoluteTargetDir, "DIRECTOR_HANDOFF.md");
    writeFileSync(
      handoffPath,
      [
        `# Director Handoff`,
        ``,
        `Project: ${metadata.projectName}`,
        `Template: ${metadata.templateId} (${metadata.stack}/${metadata.kind})`,
        `Created: ${metadata.createdAt}`,
        ``,
        `## Start Here`,
        ...(metadata.entrypoints.length ? metadata.entrypoints.map((item) => `- ${item}`) : ["- Review the scaffold root and package metadata."]),
        ``,
        `## Goals`,
        ...(metadata.directorNotes.length ? metadata.directorNotes.map((item) => `- ${item}`) : ["- Implement the requested features on top of the scaffold."]),
        ``,
        `## Suggested Commands`,
        ...(metadata.setupCommands.length ? metadata.setupCommands.map((item) => `- ${item}`) : ["- none"]),
        ...(metadata.followUpCommands.length ? metadata.followUpCommands.map((item) => `- ${item}`) : []),
      ].join("\n"),
      "utf8",
    );
    wrote.push("DIRECTOR_HANDOFF.md");
  }

  if (input.writeScaffoldTodo !== false) {
    const todoPath = join(absoluteTargetDir, "TODO.scaffold.md");
    writeFileSync(
      todoPath,
      [
        `# Scaffold Follow-up`,
        ``,
        `- [ ] Install dependencies / toolchain`,
        `- [ ] Confirm the generated project boots cleanly`,
        `- [ ] Replace placeholder copy and branding`,
        `- [ ] Implement the user-requested feature set`,
        `- [ ] Add tests for the first real feature slice`,
      ].join("\n"),
      "utf8",
    );
    wrote.push("TODO.scaffold.md");
  }

  return [
    `Post-setup completed for ${absoluteTargetDir}`,
    `Wrote: ${wrote.join(", ") || "nothing"}`,
    "",
    "Ready handoff message:",
    `Scaffolded ${metadata.templateId} at ${absoluteTargetDir}. Start with ${metadata.entrypoints[0] ?? "the project root"}, then implement the requested feature set and replace placeholder copy.`,
  ].join("\n");
}
