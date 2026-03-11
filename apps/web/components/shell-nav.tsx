"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { ConversationSummary } from "@ember/core/client";

import { clientApiPath } from "../lib/api";
import {
  announceConversationsChanged,
  CONVERSATIONS_CHANGED_EVENT,
  sortConversationSummaries,
} from "../lib/conversations";

function getConversationSectionLabel(value: string | null): string {
  if (!value) {
    return "Older";
  }

  const date = new Date(value);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfValue = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor(
    (startOfToday.getTime() - startOfValue.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays <= 0) {
    return "Today";
  }

  if (diffDays < 7) {
    return "Previous 7 days";
  }

  return "Older";
}

export function ShellNav({
  isOpen,
  onToggle,
  onClose,
}: {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeConversationId = searchParams.get("conversation");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  async function loadConversations() {
    try {
      const response = await fetch(clientApiPath("/conversations"), {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Conversation list failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as { items: ConversationSummary[] };
      setConversations(sortConversationSummaries(payload.items));
    } catch {
      setConversations([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadConversations();
  }, []);

  useEffect(() => {
    function handleChange() {
      void loadConversations();
    }

    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, handleChange);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, handleChange);
  }, []);

  useEffect(() => {
    if (!searchOpen) {
      setQuery("");
      return;
    }

    searchInputRef.current?.focus();
  }, [searchOpen]);

  async function deleteConversation(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    const conversation = conversations.find((c) => c.id === id);
    const confirmed = window.confirm(
      `Delete "${conversation?.title}"? This removes the saved chat history.`,
    );
    if (!confirmed) {
      return;
    }

    setDeletingId(id);
    try {
      const response = await fetch(clientApiPath(`/conversations/${id}`), {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(`Delete failed with status ${response.status}.`);
      }

      setConversations((current) => current.filter((item) => item.id !== id));
      if (activeConversationId === id) {
        router.push("/chat");
      }
      announceConversationsChanged();
    } finally {
      setDeletingId(null);
    }
  }

  const filteredConversations = conversations.filter((conversation) => {
    const search = query.trim().toLowerCase();
    if (!search) {
      return true;
    }

    return [conversation.title, conversation.preview]
      .join(" ")
      .toLowerCase()
      .includes(search);
  });

  const groupedConversations = filteredConversations.reduce<
    Array<{ label: string; items: ConversationSummary[] }>
  >((groups, conversation) => {
    const label = getConversationSectionLabel(conversation.lastMessageAt ?? conversation.updatedAt);
    const existing = groups.find((group) => group.label === label);

    if (existing) {
      existing.items.push(conversation);
      return groups;
    }

    return [...groups, { label, items: [conversation] }];
  }, []);

  function handleNavigate() {
    onClose();
  }

  const isNewChatActive = pathname === "/chat" && !activeConversationId;

  // Touch handling for swipe to close
  const touchStartX = useRef<number | null>(null);
  
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    
    const touchEndX = e.changedTouches[0].clientX;
    const diff = touchStartX.current - touchEndX;
    
    // Swipe left to close (threshold of 50px)
    if (diff > 50) {
      onClose();
    }
    
    touchStartX.current = null;
  };

  return (
    <aside 
      className={`sidebar${isOpen ? " open" : ""}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Mobile drag handle */}
      <div className="sidebar-drag-handle" aria-hidden="true">
        <div className="sidebar-drag-bar" />
      </div>
      
      <div className="sidebar-head">
        <div className="sidebar-header-row">
          <div className="sidebar-brand">
            <div className="sidebar-logo" aria-hidden="true">
              <svg
                className="sidebar-logo-mark"
                viewBox="0 0 32 32"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle cx="16" cy="16" r="12" stroke="currentColor" strokeWidth="1.5" opacity="0.4"/>
                <circle cx="16" cy="16" r="6" fill="currentColor" opacity="0.9"/>
              </svg>
            </div>
            <span className="sidebar-title">Ember</span>
          </div>
          <button
            className="icon-btn sidebar-close-btn"
            onClick={onToggle}
            aria-label="Close sidebar"
            title="Close sidebar"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <nav className="sidebar-actions" aria-label="Primary">
          <Link
            href="/chat"
            className={`sidebar-action${isNewChatActive ? " active" : ""}`}
            onClick={handleNavigate}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            <span>New chat</span>
          </Link>
          <button
            type="button"
            className={`sidebar-action${searchOpen ? " active" : ""}`}
            onClick={() => setSearchOpen((current) => !current)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span>Search chats</span>
          </button>
          <Link href="/settings" className="sidebar-action" onClick={handleNavigate}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </Link>
        </nav>
      </div>

      {searchOpen ? (
        <div className="sidebar-search">
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations..."
          />
        </div>
      ) : null}

      <div className="sidebar-content">
        <div className="conversation-group">
          <div className="conversation-group-title">Your chats</div>
        </div>
        {loading ? (
          <div className="conversation-group">
            <div className="conversation-item">
              <span className="conversation-item-text loading">Loading conversations...</span>
            </div>
          </div>
        ) : null}

        {!loading && filteredConversations.length === 0 ? (
          <div className="conversation-group">
            <div className="conversation-item">
              <span className="conversation-item-text">
                {query ? "No conversations found" : "No conversations yet"}
              </span>
            </div>
          </div>
        ) : null}

        {groupedConversations.map((group) => (
          <div key={group.label} className="conversation-group">
            <div className="conversation-group-title">{group.label}</div>
            {group.items.map((conversation) => {
              const active = pathname === "/chat" && activeConversationId === conversation.id;
              return (
                <Link
                  key={conversation.id}
                  href={{ pathname: "/chat", query: { conversation: conversation.id } }}
                  onClick={handleNavigate}
                  className={`conversation-item${active ? " active" : ""}`}
                >
                  <svg
                    className="conversation-item-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className="conversation-item-text">{conversation.title}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: "1.5rem", height: "1.5rem", opacity: 0 }}
                    onClick={(e) => deleteConversation(conversation.id, e)}
                    disabled={deletingId === conversation.id}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = "0")}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-account">
          <div className="sidebar-account-avatar">E</div>
          <div className="sidebar-account-copy">
            <strong>Ember Workspace</strong>
            <span>Local-first agent chat</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
