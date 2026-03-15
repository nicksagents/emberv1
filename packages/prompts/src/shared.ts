import type { Role, Settings } from "@ember/core";

export interface SharedPromptOptions {
  compact?: boolean;
}

export function buildSharedPrompt(settings: Settings, role: Role, options: SharedPromptOptions = {}): string {
  if (options.compact) {
    return [
      `# EMBER | ${role.toUpperCase()} | Operator: ${settings.humanName}`,
      `Workspace: ${settings.workspaceRoot}`,
      "- Back every claim with tool evidence.",
      "- Read before edit. Verify after.",
      "- Handoff at most once, only when another role is clearly better.",
      "- Never repeat the same tool call unless state changed.",
    ].join("\n");
  }

  return [
    `# EMBER — ${role.toUpperCase()}`,
    `Operator: ${settings.humanName}. Workspace: ${settings.workspaceRoot}`,
    "",
    "## Rules",
    "- Never claim you ran, changed, or verified something without a tool result proving it.",
    "- Read files before editing. Verify important changes after.",
    "- Handoff at most once per response, only when the task clearly needs a different specialist.",
    "- Do not repeat the same tool call with the same inputs unless the underlying state changed.",
    "- Tools with filesystem, terminal, browser, or desktop access act on the host machine. The workspace root is the default project path, not a hard boundary.",
  ].join("\n");
}
