"use client";

import Link from "next/link";
import { useState } from "react";

import type { ConnectorType, Provider } from "@ember/core/client";

import { clientApiPath } from "../lib/api";
import { PageIntro } from "./page-intro";
import { Surface } from "./surface";

interface ProviderView extends Provider {
  connectorType: ConnectorType | null;
}

export function ProvidersClient({
  initialProviders,
}: {
  initialProviders: ProviderView[];
}) {
  const [providers, setProviders] = useState(initialProviders);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger"; message: string } | null>(
    null,
  );

  async function mutateProvider(
    id: string,
    action: "connect" | "reconnect" | "recheck" | "delete",
  ) {
    setBusyId(id);
    setFeedback(null);
    const providerName = providers.find((provider) => provider.id === id)?.name ?? "Provider";

    try {
      const method = action === "delete" ? "DELETE" : "POST";
      const endpoint =
        action === "delete"
          ? clientApiPath(`/providers/${id}`)
          : clientApiPath(`/providers/${id}/${action}`);
      const response = await fetch(endpoint, {
        method,
      });

      if (!response.ok) {
        throw new Error(`${action} failed with status ${response.status}.`);
      }

      if (action === "delete") {
        setProviders((current) => current.filter((provider) => provider.id !== id));
        setFeedback({
          tone: "success",
          message: `${providerName} removed.`,
        });
        return;
      }

      const payload = (await response.json()) as { item: Provider };
      setProviders((current) =>
        current.map((provider) =>
          provider.id === id
            ? {
                ...provider,
                ...payload.item,
              }
            : provider,
        ),
      );
      setFeedback({
        tone: "success",
        message: `${providerName} updated.`,
      });
    } catch (error) {
      setFeedback({
        tone: "danger",
        message: error instanceof Error ? error.message : "Provider action failed.",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageIntro
        eyebrow="Providers"
        title="Providers"
        description="Connect only the providers you actually use."
        actions={
          <div className="button-row">
            <Link className="button primary" href="/providers/new">
              Add provider
            </Link>
          </div>
        }
      />

      {feedback ? (
        <Surface>
          <p className={feedback.tone === "danger" ? "error-copy" : ""}>{feedback.message}</p>
        </Surface>
      ) : null}

      <section className="list-stack">
        {providers.map((provider) => (
          <Surface key={provider.id} className="provider-row">
            <div className="provider-head">
              <div className="provider-copy">
                <p className="section-label">{provider.connectorType?.name ?? provider.typeId}</p>
                <h3>{provider.name}</h3>
                <div className="provider-meta">
                  <span>{provider.availableModels.length || 0} models</span>
                  <span>{provider.capabilities.canChat ? "Live chat" : "Auth only"}</span>
                  <span>{provider.typeId}</span>
                </div>
              </div>
              <span className={`status-badge ${provider.status}`}>{provider.status}</span>
            </div>
            <p className={provider.lastError ? "error-copy" : "helper-copy"}>
              {provider.lastError ||
                provider.connectorType?.description ||
                "No connector description available."}
            </p>
            <div className="button-row provider-actions">
              <button
                className="button primary"
                onClick={() => mutateProvider(provider.id, "connect")}
                disabled={busyId === provider.id}
              >
                Connect
              </button>
              <button
                className="button"
                onClick={() => mutateProvider(provider.id, "reconnect")}
                disabled={busyId === provider.id}
              >
                Reconnect
              </button>
              <button
                className="button"
                onClick={() => mutateProvider(provider.id, "recheck")}
                disabled={busyId === provider.id}
              >
                Recheck
              </button>
              <button
                className="button ghost"
                onClick={() => {
                  const confirmed = window.confirm(
                    `Remove provider "${provider.name}"? This also clears any role assignments using it.`,
                  );
                  if (confirmed) {
                    void mutateProvider(provider.id, "delete");
                  }
                }}
                disabled={busyId === provider.id}
              >
                Remove
              </button>
            </div>
          </Surface>
        ))}
        {providers.length === 0 ? (
          <Surface className="empty-state">
            <p className="section-label">No providers yet</p>
            <h3>Add one connector</h3>
            <p className="page-copy">
              Start with Codex, Claude Code, Anthropic API, or a local OpenAI-compatible endpoint.
            </p>
            <Link className="button primary" href="/providers/new">
              Add provider
            </Link>
          </Surface>
        ) : null}
      </section>
    </>
  );
}
