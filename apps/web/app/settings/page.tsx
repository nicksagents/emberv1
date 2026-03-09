import type {
  ConnectorType,
  ConnectorTypeId,
  Provider,
  RoleAssignment,
  RuntimeState,
  Settings,
} from "@ember/core/client";

import { SettingsClient } from "../../components/settings-client";
import { getJson } from "../../lib/api";

export default async function SettingsPage() {
  const [settings, runtime, providers, roles, connectorTypes, connectorModels] = await Promise.all([
    getJson<{ item: Settings }>("/api/settings"),
    getJson<{ runtime: RuntimeState; settings: Settings }>("/api/runtime"),
    getJson<{ items: Array<Provider & { connectorType: ConnectorType | null }> }>("/api/providers"),
    getJson<{ items: RoleAssignment[]; providers: Provider[] }>("/api/roles"),
    getJson<{ items: ConnectorType[] }>("/api/connector-types"),
    getJson<{ items: Partial<Record<ConnectorTypeId, string[]>> }>("/api/connector-models"),
  ]);

  return (
    <SettingsClient
      initialSettings={settings.item}
      runtime={runtime.runtime}
      initialProviders={providers.items}
      connectorTypes={connectorTypes.items}
      modelCatalog={connectorModels.items}
      initialAssignments={roles.items}
    />
  );
}
