#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getTemplateOptions, listTemplates, postSetup, scaffoldProject } from "./scaffold.js";

const server = new McpServer({
  name: "project-scaffold",
  version: "0.1.0",
});

server.registerTool(
  "list_templates",
  {
    description: "List the available deterministic project templates for scaffolding new repos or starter projects.",
    inputSchema: {
      stack: z.string().optional().describe("Optional stack filter, for example nextjs, react, python, rust, node, typescript, javascript."),
      kind: z.string().optional().describe("Optional kind filter, for example app, api, library, cli, or service."),
      query: z.string().optional().describe("Optional free-text search across ids, titles, descriptions, and tags."),
    },
  },
  async ({ stack, kind, query }) => ({
    content: [{ type: "text", text: listTemplates({ stack, kind, query }) }],
  }),
);

server.registerTool(
  "get_template_options",
  {
    description: "Show defaults, options, and director follow-up focus for a specific template.",
    inputSchema: {
      template_id: z.string().describe("Template id from list_templates, for example nextjs-app or rust-cli."),
    },
  },
  async ({ template_id }) => ({
    content: [{ type: "text", text: getTemplateOptions(template_id) }],
  }),
);

server.registerTool(
  "scaffold_project",
  {
    description: "Create a new project from a curated template, write stack-specific AGENTS and Ember skill files, and record metadata for later handoff.",
    inputSchema: {
      template_id: z.string().describe("Template id from list_templates."),
      target_dir: z.string().describe("Relative path inside the current workspace where the project should be created."),
      project_name: z.string().describe("Human-facing project name."),
      package_manager: z.enum(["pnpm", "npm", "yarn", "bun"]).optional().describe("Optional package manager override for JavaScript/TypeScript templates."),
      overwrite: z.boolean().optional().describe("Set true only when the target directory already exists and you want to write into it."),
      answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Optional template-specific answer map. Use get_template_options first to see keys."),
    },
  },
  async ({ template_id, target_dir, project_name, package_manager, overwrite, answers }) => ({
    content: [{
      type: "text",
      text: scaffoldProject({
        templateId: template_id,
        targetDir: target_dir,
        projectName: project_name,
        packageManager: package_manager,
        overwrite,
        answers,
      }),
    }],
  }),
);

server.registerTool(
  "post_setup",
  {
    description: "Write the director handoff markdown and a scaffold follow-up checklist for a generated project.",
    inputSchema: {
      target_dir: z.string().describe("Relative path to the scaffolded project."),
      write_director_handoff: z.boolean().optional().describe("Set false to skip DIRECTOR_HANDOFF.md."),
      write_scaffold_todo: z.boolean().optional().describe("Set false to skip TODO.scaffold.md."),
    },
  },
  async ({ target_dir, write_director_handoff, write_scaffold_todo }) => ({
    content: [{
      type: "text",
      text: postSetup({
        targetDir: target_dir,
        writeDirectorHandoff: write_director_handoff,
        writeScaffoldTodo: write_scaffold_todo,
      }),
    }],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[project-scaffold] MCP server ready on stdio");
}

main().catch((error) => {
  console.error("[project-scaffold] Server error:", error);
  process.exit(1);
});
