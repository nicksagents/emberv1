import type {
  ConnectorType,
  ConnectorTypeId,
  Provider,
  RoleAssignment,
  RuntimeState,
  Settings,
} from "@ember/core/client";
import type { McpServerConfig } from "@ember/core/mcp";

import { SettingsClient } from "../../components/settings-client";
import { getJson } from "../../lib/api";

type McpConfigScope = "default" | "user" | "project";

interface McpServerStatus {
  name: string;
  sourceScope: McpConfigScope;
  config: McpServerConfig;
  roles: RoleAssignment["role"][];
  toolNames: string[];
  status: "running" | "error" | "disabled" | "configured";
  lastError: string | null;
  activeCalls?: number;
  target?: string;
}

interface McpState {
  layers: Array<{
    scope: McpConfigScope;
    path: string;
    exists: boolean;
    serverCount: number;
  }>;
  items: McpServerStatus[];
  merged: Array<{
    name: string;
    sourceScope: McpConfigScope;
    config: McpServerConfig;
    target?: string;
  }>;
  stats: {
    configuredServers: number;
    runningServers: number;
    drainingServers?: number;
    activeTools: number;
    activeCalls?: number;
  };
}

export default async function SettingsPage() {
  const [settings, runtime, providers, roles, connectorTypes, connectorModels, mcp] = await Promise.all([
    getJson<{ item: Settings }>("/api/settings"),
    getJson<{ runtime: RuntimeState; settings: Settings }>("/api/runtime"),
    getJson<{ items: Array<Provider & { connectorType: ConnectorType | null }> }>("/api/providers"),
    getJson<{ items: RoleAssignment[]; providers: Provider[] }>("/api/roles"),
    getJson<{ items: ConnectorType[] }>("/api/connector-types"),
    getJson<{ items: Partial<Record<ConnectorTypeId, string[]>> }>("/api/connector-models"),
    getJson<McpState>("/api/mcp/servers"),
  ]);

  return (
    <SettingsClient
      initialSettings={settings.item}
      runtime={runtime.runtime}
      initialProviders={providers.items}
      connectorTypes={connectorTypes.items}
      modelCatalog={connectorModels.items}
      initialAssignments={roles.items}
      initialMcpState={mcp}
    />
  );
}
