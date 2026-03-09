import type { Provider, RoleAssignment, Settings } from "@ember/core/client";

import { ChatClient } from "../../components/chat-client";
import { getJson } from "../../lib/api";

export default async function ChatPage() {
  const [providers, roles, settings] = await Promise.all([
    getJson<{ items: Provider[] }>("/api/providers"),
    getJson<{ items: RoleAssignment[] }>("/api/roles"),
    getJson<{ item: Settings }>("/api/settings"),
  ]);

  return (
    <ChatClient
      providers={providers.items}
      assignments={roles.items}
      settings={settings.item}
    />
  );
}
