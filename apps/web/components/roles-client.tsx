"use client";

import { useMemo, useState } from "react";

import type { Provider, RoleAssignment } from "@ember/core/client";

import { clientApiPath } from "../lib/api";
import { PageIntro } from "./page-intro";
import { Surface } from "./surface";

export function RolesClient({
  initialAssignments,
  providers,
}: {
  initialAssignments: RoleAssignment[];
  providers: Provider[];
}) {
  const [assignments, setAssignments] = useState(initialAssignments);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const providerMap = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );

  function updateRole(role: RoleAssignment["role"], field: "providerId" | "modelId", value: string) {
    setAssignments((current) =>
      current.map((assignment) =>
        assignment.role === role
          ? {
              ...assignment,
              [field]: value || null,
            }
          : assignment,
      ),
    );
  }

  async function save() {
    setSaving(true);
    setNotice(null);

    try {
      const response = await fetch(clientApiPath("/roles"), {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ items: assignments }),
      });

      if (!response.ok) {
        throw new Error(`Save failed with status ${response.status}.`);
      }

      setNotice("Role assignments saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageIntro
        eyebrow="Roles"
        title="Roles"
        description="Assign a provider and model to the roles you care about."
        actions={
          <div className="button-row">
            <button className="button primary" onClick={save} disabled={saving}>
              {saving ? "Saving..." : "Save assignments"}
            </button>
          </div>
        }
      />

      {notice ? (
        <Surface>
          <p>{notice}</p>
        </Surface>
      ) : null}

      <section className="list-stack">
        {assignments.map((assignment) => {
          const selectedProvider = assignment.providerId
            ? providerMap.get(assignment.providerId) ?? null
            : null;
          const modelListId = `${assignment.role}-models`;

          return (
            <Surface key={assignment.role} className="role-row">
              <div className="role-head">
                <div className="role-copy">
                  <p className="section-label">{assignment.role}</p>
                  <h3>{selectedProvider?.name ?? "Unassigned"}</h3>
                </div>
                <span className={`status-badge ${selectedProvider?.status ?? "missing"}`}>
                  {selectedProvider?.status ?? "unassigned"}
                </span>
              </div>
              <div className="form-grid">
                <label className="field">
                  <span>Provider</span>
                  <select
                    value={assignment.providerId ?? ""}
                    onChange={(event) =>
                      updateRole(assignment.role, "providerId", event.target.value)
                    }
                  >
                    <option value="">Unassigned</option>
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Model id</span>
                  {selectedProvider?.availableModels.length ? (
                    <>
                      <input
                        list={modelListId}
                        value={assignment.modelId ?? ""}
                        onChange={(event) =>
                          updateRole(assignment.role, "modelId", event.target.value)
                        }
                        placeholder={
                          selectedProvider.availableModels[0] ?? "Optional model id"
                        }
                      />
                      <datalist id={modelListId}>
                        {selectedProvider.availableModels.map((modelId) => (
                          <option key={modelId} value={modelId} />
                        ))}
                      </datalist>
                    </>
                  ) : (
                    <input
                      value={assignment.modelId ?? ""}
                      onChange={(event) =>
                        updateRole(assignment.role, "modelId", event.target.value)
                      }
                      placeholder={
                        selectedProvider?.config.defaultModelId?.trim() ||
                        (selectedProvider?.typeId === "codex-cli"
                          ? "Optional Codex model id"
                          : "Optional model id")
                      }
                    />
                  )}
                </label>
                <p className="helper-copy">
                  {selectedProvider
                    ? selectedProvider.typeId === "codex-cli"
                      ? "Optional. When set, EMBER passes this through to Codex as the selected model."
                      : `${selectedProvider.availableModels.length} known models. ${
                          selectedProvider.capabilities.canChat ? "Live chat ready." : "Auth only."
                        }`
                    : "Pick a provider first."}
                </p>
              </div>
            </Surface>
          );
        })}
      </section>
    </>
  );
}
