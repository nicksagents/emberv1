"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

import type { ConnectorType } from "@ember/core/client";

import { clientApiPath } from "../lib/api";
import { PageIntro } from "./page-intro";
import { Surface } from "./surface";

export function ProviderCreateForm({
  connectorTypes,
}: {
  connectorTypes: ConnectorType[];
}) {
  const router = useRouter();
  const [typeId, setTypeId] = useState<ConnectorType["id"]>("codex-cli");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [defaultModelId, setDefaultModelId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const activeType = useMemo(
    () => connectorTypes.find((connector) => connector.id === typeId) ?? connectorTypes[0],
    [connectorTypes, typeId],
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);

    const config: Record<string, string> = {};
    const secrets: Record<string, string> = {};

    if ((typeId === "codex-cli" || typeId === "claude-code-cli") && defaultModelId.trim()) {
      config.defaultModelId = defaultModelId.trim();
    }

    if (typeId === "openai-compatible") {
      config.baseUrl = baseUrl;
      config.defaultModelId = defaultModelId;
      if (apiKey) {
        secrets.apiKey = apiKey;
      }
    }

    if (typeId === "anthropic-api") {
      config.defaultModelId = defaultModelId;
      if (apiKey) {
        secrets.apiKey = apiKey;
      }
    }

    const response = await fetch(clientApiPath("/providers"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: name.trim() || activeType.name,
        typeId,
        config,
        secrets,
      }),
    });

    if (response.ok) {
      const payload = (await response.json()) as { item: { id: string } };
      if (typeId === "anthropic-api" || typeId === "openai-compatible") {
        await fetch(clientApiPath(`/providers/${payload.item.id}/recheck`), {
          method: "POST",
        });
      }
      router.push("/providers");
      router.refresh();
      return;
    }

    setSubmitting(false);
  }

  return (
    <>
      <PageIntro
        eyebrow="Add provider"
        title="Add provider"
        description="Pick a connector, save it, then recheck it once."
      />

      <Surface className="form-surface">
        <form className="form-grid" onSubmit={onSubmit}>
          <label className="field">
            <span>Connector type</span>
            <select value={typeId} onChange={(event) => setTypeId(event.target.value as ConnectorType["id"])}>
              {connectorTypes.map((connector) => (
                <option key={connector.id} value={connector.id}>
                  {connector.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Display name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={activeType.name}
            />
          </label>

          <Surface className="inner-surface">
            <p className="section-label">Setup</p>
            <h3>{activeType.name}</h3>
            <p className="page-copy">{activeType.description}</p>
            {typeId === "codex-cli" ? (
              <>
                <p className="page-copy">
                  If you already ran `codex login`, save this and press Recheck on the Providers
                  page.
                </p>
                <p className="page-copy">
                  Optional model ids are passed through to `codex exec -m ...` during chat runs.
                </p>
              </>
            ) : null}
            {typeId === "claude-code-cli" ? (
              <>
                <p className="page-copy">
                  If you already ran `claude auth login`, save this and press Recheck on the
                  Providers page.
                </p>
                <p className="page-copy">
                  Discovered model ids are passed through to `claude --model ...` when execution support is enabled.
                </p>
              </>
            ) : null}
          </Surface>

          {typeId === "codex-cli" || typeId === "claude-code-cli" ? (
            <label className="field">
              <span>Default model id</span>
              <input
                value={defaultModelId}
                onChange={(event) => setDefaultModelId(event.target.value)}
                placeholder={
                  typeId === "codex-cli"
                    ? "Optional Codex model id"
                    : "Optional Claude model id"
                }
              />
            </label>
          ) : null}

          {typeId === "anthropic-api" ? (
            <>
              <label className="field">
                <span>API key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-ant-..."
                />
              </label>
              <label className="field">
                <span>Default model id</span>
                <input
                  value={defaultModelId}
                  onChange={(event) => setDefaultModelId(event.target.value)}
                  placeholder="claude-3-7-sonnet-latest"
                />
              </label>
            </>
          ) : null}

          {typeId === "openai-compatible" ? (
            <>
              <label className="field">
                <span>Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://127.0.0.1:11434/v1"
                />
              </label>
              <label className="field">
                <span>Optional API key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Leave blank for local endpoints"
                />
              </label>
              <label className="field">
                <span>Default model id</span>
                <input
                  value={defaultModelId}
                  onChange={(event) => setDefaultModelId(event.target.value)}
                  placeholder="qwen2.5-coder:latest"
                />
              </label>
            </>
          ) : null}

          <div className="button-row">
            <button className="button primary" type="submit" disabled={submitting}>
              {submitting ? "Creating..." : "Create provider"}
            </button>
          </div>
        </form>
      </Surface>
    </>
  );
}
