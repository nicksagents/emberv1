import type { PromptStack, Role, Settings } from "@ember/core";

import { assistantPrompt } from "./assistant.js";
import { auditorPrompt } from "./auditor.js";
import { coderPrompt } from "./coder.js";
import { janitorPrompt } from "./janitor.js";
import { plannerPrompt } from "./planner.js";
import { routerPrompt } from "./router.js";
import { buildSharedPrompt } from "./shared.js";

const rolePromptMap: Record<Role, string> = {
  router: routerPrompt,
  assistant: assistantPrompt,
  planner: plannerPrompt,
  coder: coderPrompt,
  auditor: auditorPrompt,
  janitor: janitorPrompt,
};

export function getPromptStack(settings: Settings, role: Role): PromptStack {
  if (role === "router") {
    const override = settings.systemPrompts.roles.router.trim();
    return { shared: override || routerPrompt, role: "" };
  }

  const sharedOverride = settings.systemPrompts.shared.trim();
  const roleOverride = settings.systemPrompts.roles[role].trim();

  return {
    shared: [buildSharedPrompt(settings, role), sharedOverride].filter(Boolean).join("\n\n"),
    role: roleOverride || rolePromptMap[role],
  };
}

export { assistantPrompt, auditorPrompt, coderPrompt, janitorPrompt, plannerPrompt, routerPrompt };
