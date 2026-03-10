import type { ConversationSummary } from "@ember/core/client";

export const CONVERSATIONS_CHANGED_EVENT = "ember:conversations-changed";

export function announceConversationsChanged() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT));
}

export function sortConversationSummaries(
  conversations: ConversationSummary[],
): ConversationSummary[] {
  return [...conversations].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}
