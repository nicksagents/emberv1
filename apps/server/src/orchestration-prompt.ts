import { ROLES, type PromptStack, type Provider, type Role, type RoleAssignment, type Settings, type ToolDefinition } from "@ember/core";
import { getPromptStack } from "@ember/prompts";
import { getToolSystemPrompt, getToolsForRole } from "./tools/index.js";

const ROUTEABLE_ROLES: Role[] = ["coordinator", "advisor", "director", "inspector"];
const ROLE_ORDER: Role[] = ["dispatch", "coordinator", "advisor", "director", "inspector", "ops"];
const ROLE_LANES: Record<Role, string> = {
  dispatch: "routing only",
  coordinator: "default execution, research, browsing, and short build loops",
  advisor: "planning, architecture, and sequencing before implementation",
  director: "deep implementation, debugging, and broad build/test/fix loops",
  inspector: "review, QA, validation, and bug-finding",
  ops: "safe cleanup and small polish only",
};

function resolveAssignedModel(provider: Provider | null, assignment: RoleAssignment | undefined): string | null {
  return assignment?.modelId ?? provider?.config.defaultModelId ?? provider?.availableModels[0] ?? null;
}

function formatProviderLane(provider: Provider | null, assignment: RoleAssignment | undefined): string {
  const modelId = resolveAssignedModel(provider, assignment);
  if (!provider) {
    return "unassigned";
  }

  const lane = [provider.name, modelId].filter(Boolean).join(" / ");
  if (provider.status !== "connected") {
    return `${lane || provider.name} (${provider.status})`;
  }
  return lane || provider.name;
}

function formatRoleLane(
  role: Role,
  assignmentMap: Map<Role, RoleAssignment>,
  providers: Provider[],
): string {
  const assignment = assignmentMap.get(role);
  const provider = providers.find((candidate) => candidate.id === assignment?.providerId) ?? null;
  return `${role}=${formatProviderLane(provider, assignment)}`;
}

function toTitleCase(value: string): string {
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function collectMcpServerRoster(): Array<{ serverName: string; roles: Role[] }> {
  const servers = new Map<string, Set<Role>>();

  for (const role of ROLES) {
    for (const tool of getToolsForRole(role)) {
      if (!tool.name.startsWith("mcp__")) {
        continue;
      }
      const [, serverName] = tool.name.split("__");
      if (!serverName) {
        continue;
      }
      let roles = servers.get(serverName);
      if (!roles) {
        roles = new Set<Role>();
        servers.set(serverName, roles);
      }
      roles.add(role);
    }
  }

  return Array.from(servers.entries())
    .map(([serverName, roles]) => ({
      serverName,
      roles: ROLE_ORDER.filter((role) => roles.has(role)),
    }))
    .sort((left, right) => left.serverName.localeCompare(right.serverName));
}

export function buildOrchestrationPrompt(options: {
  role: Role;
  providers: Provider[];
  assignmentMap: Map<Role, RoleAssignment>;
  compact?: boolean;
}): string {
  const compact = options.compact === true;
  const currentLane = formatRoleLane(options.role, options.assignmentMap, options.providers);
  const specialistRoles =
    options.role === "dispatch"
      ? ROUTEABLE_ROLES
      : ROLE_ORDER.filter((role) => role !== "dispatch" && role !== options.role);
  const mcpRoster = collectMcpServerRoster();

  if (compact) {
    const specialistSummary = specialistRoles
      .slice(0, 4)
      .map((role) => formatRoleLane(role, options.assignmentMap, options.providers))
      .join("; ");
    const compactMcp = mcpRoster
      .slice(0, 3)
      .map((entry) => `${entry.serverName}[${entry.roles.join("/")}]`)
      .join("; ");

    return [
      "## Team",
      `Current lane: ${currentLane}.`,
      specialistSummary ? `Other lanes: ${specialistSummary}.` : "",
      compactMcp ? `MCP: ${compactMcp}.` : "",
      "Handoff switches to the target lane. Inside that lane, the provider router may choose a better connected provider and the model router may choose a better model. Use handoff only when another lane has the clearer task fit or tool surface.",
      "If launch_parallel_tasks is available, use it only for independent subtasks that can run concurrently without overlapping file edits.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const roleLines = [options.role, ...specialistRoles]
    .filter((role, index, roles) => roles.indexOf(role) === index)
    .map((role) => {
      const assignment = options.assignmentMap.get(role);
      const provider = options.providers.find((candidate) => candidate.id === assignment?.providerId) ?? null;
      return `- ${role}: ${ROLE_LANES[role]}. Lane: ${formatProviderLane(provider, assignment)}`;
    });
  const mcpLines = mcpRoster.map((entry) => `- ${toTitleCase(entry.serverName)}: ${entry.roles.join(", ")}`);

  return [
    "## Team Orchestration",
    `Current role: ${options.role}. Current lane: ${currentLane}.`,
    "Role lanes:",
    ...roleLines,
    ...(mcpLines.length > 0 ? ["", "Global MCP surfaces:", ...mcpLines] : []),
    "",
    "Stay in your lane if you can complete the work in one focused pass.",
    "Use handoff only when another role has the better lane or tool surface.",
    "A handoff automatically continues the task on the receiving role, and the provider/model routers may switch to a better connected provider and model inside that lane.",
    "If launch_parallel_tasks is available, use it only for independent subtasks that can run concurrently without overlapping file edits.",
  ].join("\n");
}

export function buildRolePromptStack(options: {
  settings: Settings;
  role: Role;
  tools: ToolDefinition[];
  providers: Provider[];
  assignmentMap: Map<Role, RoleAssignment>;
  compactRolePrompt?: boolean;
  compactToolPrompt?: boolean;
  extraSharedSections?: string[];
}): PromptStack {
  const promptStack = getPromptStack(options.settings, options.role, {
    compact: options.compactRolePrompt,
  });
  const orchestrationPrompt = buildOrchestrationPrompt({
    role: options.role,
    providers: options.providers,
    assignmentMap: options.assignmentMap,
    compact: options.compactRolePrompt || options.compactToolPrompt,
  });

  promptStack.shared = [
    promptStack.shared,
    orchestrationPrompt,
    ...(options.extraSharedSections ?? []),
  ].filter(Boolean).join("\n\n");
  promptStack.tools = getToolSystemPrompt(options.tools, options.role, {
    compact: options.compactToolPrompt,
  });

  return promptStack;
}
