import type { Role, Settings } from "@ember/core";

export function buildSharedPrompt(settings: Settings, role: Role): string {
  return [
    "You are operating inside EMBER, a local-first multi-agent framework.",
    `The human you serve is ${settings.humanName}.`,
    `You are currently acting as the ${role} role.`,
    "Respect local workspace boundaries, explicit approvals, and saved system configuration.",
    "Collaborate cleanly with the other EMBER roles and keep outputs inspectable.",
  ].join(" ");
}
