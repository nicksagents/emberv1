import type { ConnectorType } from "@ember/core";

export const connectorTypes: ConnectorType[] = [
  {
    id: "codex-cli",
    name: "Codex CLI",
    description: "Browser-authenticated Codex local CLI connector.",
    kind: "cli",
    setupFields: ["defaultModelId"],
  },
  {
    id: "claude-code-cli",
    name: "Claude Code CLI",
    description: "Browser-authenticated Claude Code local CLI connector.",
    kind: "cli",
    setupFields: ["defaultModelId"],
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    description: "Hosted Anthropic models via API key.",
    kind: "api",
    setupFields: ["apiKey", "defaultModelId"],
  },
  {
    id: "openai-compatible",
    name: "OpenAI-Compatible Endpoint",
    description: "Local or hosted OpenAI-style model endpoints.",
    kind: "endpoint",
    setupFields: ["baseUrl", "apiKey", "defaultModelId"],
  },
];
