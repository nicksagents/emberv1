import assert from "node:assert/strict";
import test from "node:test";

import { defaultSettings } from "@ember/core";
import type { McpServerConfig } from "@ember/core/mcp";

import {
  REDACTED_SECRET_VALUE,
  buildSettingsSecretStatus,
  redactMcpServerConfig,
  redactSettingsForApi,
  unmaskMcpSecretRecord,
} from "./api-redaction.js";

test("redactSettingsForApi clears secret fields but keeps rest of settings", () => {
  const settings = defaultSettings("/tmp/workspace");
  settings.sudoPassword = "sudo-secret";
  settings.braveApiKey = "brave-secret";
  const redacted = redactSettingsForApi(settings);

  assert.equal(redacted.sudoPassword, "");
  assert.equal(redacted.braveApiKey, "");
  assert.equal(redacted.workspaceRoot, "/tmp/workspace");
});

test("buildSettingsSecretStatus reports whether secret values are configured", () => {
  const settings = defaultSettings("/tmp/workspace");
  settings.sudoPassword = " sudo ";
  settings.braveApiKey = "";
  assert.deepEqual(buildSettingsSecretStatus(settings), {
    sudoPasswordSet: true,
    braveApiKeySet: false,
  });
});

test("redactMcpServerConfig masks sensitive env values but preserves non-sensitive ones", () => {
  const config: McpServerConfig = {
    command: "npx",
    args: ["-y", "demo-mcp"],
    env: {
      DEMO_KEY: "secret",
      GMAIL_APP_PASSWORD: "hunter2",
      GMAIL_EMAIL: "user@gmail.com",
      SLACK_TEAM_ID: "T123",
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_abc",
    },
    headers: {
      Authorization: "Bearer abc",
    },
  };
  const redacted = redactMcpServerConfig(config);
  // Sensitive keys are redacted
  assert.equal(redacted.env?.DEMO_KEY, REDACTED_SECRET_VALUE);
  assert.equal(redacted.env?.GMAIL_APP_PASSWORD, REDACTED_SECRET_VALUE);
  assert.equal(redacted.env?.GITHUB_PERSONAL_ACCESS_TOKEN, REDACTED_SECRET_VALUE);
  // Non-sensitive keys are preserved
  assert.equal(redacted.env?.GMAIL_EMAIL, "user@gmail.com");
  assert.equal(redacted.env?.SLACK_TEAM_ID, "T123");
  // Headers are always redacted (contain auth tokens)
  assert.equal(redacted.headers?.Authorization, REDACTED_SECRET_VALUE);
});

test("unmaskMcpSecretRecord keeps existing values for masked payload entries", () => {
  const next = unmaskMcpSecretRecord(
    {
      DEMO_KEY: REDACTED_SECRET_VALUE,
      NEW_KEY: "new-value",
    },
    {
      DEMO_KEY: "existing-secret",
    },
  );

  assert.deepEqual(next, {
    DEMO_KEY: "existing-secret",
    NEW_KEY: "new-value",
  });
});
