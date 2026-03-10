import type { PromptStack, Role, Settings } from "@ember/core";

import { advisorPrompt } from "./advisor.js";
import { coordinatorPrompt } from "./coordinator.js";
import { directorPrompt } from "./director.js";
import { dispatchPrompt } from "./dispatch.js";
import { inspectorPrompt } from "./inspector.js";
import { opsPrompt } from "./ops.js";
import { buildSharedPrompt } from "./shared.js";

const rolePromptMap: Record<Role, string> = {
  dispatch: dispatchPrompt,
  coordinator: coordinatorPrompt,
  advisor: advisorPrompt,
  director: directorPrompt,
  inspector: inspectorPrompt,
  ops: opsPrompt,
};

export function getPromptStack(settings: Settings, role: Role): PromptStack {
  if (role === "dispatch") {
    const override = settings.systemPrompts.roles.dispatch.trim();
    return {
      shared: "",
      role: override || dispatchPrompt,
      tools: "",
    };
  }

  const sharedOverride = settings.systemPrompts.shared.trim();
  const roleOverride = settings.systemPrompts.roles[role].trim();

  return {
    shared: [buildSharedPrompt(settings, role), sharedOverride].filter(Boolean).join("\n\n"),
    role: roleOverride || rolePromptMap[role],
    tools: "",
  };
}

export { advisorPrompt, coordinatorPrompt, directorPrompt, dispatchPrompt, inspectorPrompt, opsPrompt };
