"use client";

import Link from "next/link";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type {
  ChatAttachment,
  ChatMessage,
  ChatMode,
  ChatStreamEvent,
  Conversation,
  ConversationSummary,
  Provider,
  RoleAssignment,
  Settings,
} from "@ember/core/client";
import { ROLES } from "@ember/core/client";

import { clientApiPath, clientStreamApiPath } from "../lib/api";
import { announceConversationsChanged } from "../lib/conversations";
import { MessageRenderer, StreamingContent, ThinkingPanel } from "./message-renderer";

const directModes = ROLES.filter((role) => role !== "dispatch" && role !== "coordinator");
const modes = ["auto", "coordinator", ...directModes] as const;
const MAX_IMAGE_ATTACHMENTS = 3;
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

function normalizeMode(mode: ChatMode): (typeof modes)[number] {
  return mode === "dispatch" ? "auto" : mode;
}

const suggestionPrompts = [
  {
    title: "Plan the next feature",
    description: "Break the next milestone into concrete implementation steps.",
    value: "Plan the next feature for this workspace.",
  },
  {
    title: "Audit the current setup",
    description: "Review the runtime, roles, and any obvious setup gaps.",
    value: "Audit the current Ember setup and call out issues.",
  },
  {
    title: "Explain this workspace",
    description: "Summarize the moving parts and how the app is wired together.",
    value: "Explain this workspace and how the main pieces fit together.",
  },
  {
    title: "List connected providers",
    description: "Show which providers are available and ready for chat.",
    value: "List the connected providers and their current status.",
  },
];

interface StreamingPreview {
  content: string;
  thinking: string;
  status: string;
  phase: "routing" | "provider" | "streaming" | "saving";
  providerName: string | null;
  role: string | null;
  modelId: string | null;
}

function titleCase(value: string | null | undefined): string {
  if (!value) {
    return "Ember";
  }

  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function getModeLabel(mode: (typeof modes)[number]): string {
  return mode === "auto" ? "Auto" : titleCase(mode);
}

function readImageAttachment(file: File): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) {
        reject(new Error(`Failed to read ${file.name}.`));
        return;
      }

      resolve({
        id: `attachment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: "image",
        name: file.name,
        mediaType: file.type || "image/jpeg",
        dataUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

async function fetchConversationSnapshot(id: string): Promise<Conversation | null> {
  const response = await fetch(clientApiPath(`/conversations/${id}`), {
    cache: "no-store",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Conversation load failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as { item: Conversation };
  return payload.item;
}

export function ChatClient({
  providers,
  assignments,
  settings,
}: {
  providers: Provider[];
  assignments: RoleAssignment[];
  settings: Settings;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedConversationId = searchParams.get("conversation");
  const [mode, setMode] = useState<(typeof modes)[number]>("auto");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [sending, setSending] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [streamingPreview, setStreamingPreview] = useState<StreamingPreview | null>(null);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const roleMenuRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const autoScrollRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    const scrollEl = messagesScrollRef.current;
    if (!scrollEl) {
      return;
    }

    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior });
  };

  const assignmentMap = useMemo(
    () => new Map(assignments.map((assignment) => [assignment.role, assignment])),
    [assignments],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadConversation(id: string) {
      setLoadingConversation(true);
      setErrorMessage(null);

      try {
        const item = await fetchConversationSnapshot(id);
        if (!item) {
          if (!cancelled) {
            setConversation(null);
            setMessages([]);
            router.replace("/chat");
            announceConversationsChanged();
          }
          return;
        }
        if (cancelled) {
          return;
        }

        const { messages: nextMessages, ...summary } = item;
        setConversation(summary);
        setMessages(nextMessages);
        setMode(normalizeMode(item.mode));
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : "Conversation load failed.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingConversation(false);
        }
      }
    }

    if (!selectedConversationId) {
      setConversation(null);
      setMessages([]);
      setLoadingConversation(false);
      setMode("auto");
      setErrorMessage(null);
      setStreamingPreview(null);
      return () => {
        cancelled = true;
      };
    }

    void loadConversation(selectedConversationId);

    return () => {
      cancelled = true;
    };
  }, [router, selectedConversationId]);

  // Scroll detection for "scroll to bottom" button
  useEffect(() => {
    const scrollEl = messagesScrollRef.current;
    if (!scrollEl) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const isNearBottom = distanceFromBottom < 100;
      autoScrollRef.current = isNearBottom;
      setShowScrollToBottom(!isNearBottom && (messages.length > 0 || streamingPreview !== null));
    };

    handleScroll();
    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", handleScroll);
  }, [messages.length, streamingPreview]);

  const scrollToBottom = () => {
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    scrollToLatest("smooth");
  };

  const routerAssignment = assignmentMap.get("dispatch");
  const routerProvider =
    providers.find((provider) => provider.id === routerAssignment?.providerId) ?? null;
  const activeAssignment = mode === "auto" ? null : assignmentMap.get(mode);
  const activeProvider =
    mode === "auto"
      ? null
      : providers.find((provider) => provider.id === activeAssignment?.providerId) ?? null;
  const activeImageProvider = mode === "auto" ? routerProvider : activeProvider;
  const setupReady =
    mode === "auto"
      ? Boolean(
          routerProvider &&
            routerProvider.status === "connected" &&
            routerProvider.capabilities.canChat &&
            (routerAssignment?.modelId ||
              routerProvider.config.defaultModelId?.trim() ||
              routerProvider.availableModels[0] ||
              !routerProvider.capabilities.canListModels),
        )
      : Boolean(
          activeProvider &&
            (activeAssignment?.modelId ||
              activeProvider.config.defaultModelId?.trim() ||
              activeProvider.availableModels[0] ||
          !activeProvider.capabilities.canListModels),
        );
  const imageInputReady =
    activeImageProvider?.status === "connected" && activeImageProvider.capabilities.canUseImages;

  const userName = settings.humanName?.trim() || "there";
  const greeting =
    messages.length === 0 ? `Good day, ${userName}` : (conversation?.title ?? "Ember");
  useEffect(() => {
    const element = composerRef.current;
    if (!element) {
      return;
    }

    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [input]);

  // Reset textarea height after sending
  useEffect(() => {
    if (!sending) {
      const element = composerRef.current;
      if (element) {
        element.style.height = "auto";
      }
    }
  }, [sending]);

  useEffect(() => {
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
  }, [selectedConversationId]);

  useEffect(() => {
    if (loadingConversation) {
      return;
    }

    if (messages.length === 0 || !autoScrollRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      scrollToLatest("auto");
    });
  }, [selectedConversationId, loadingConversation, messages.length]);

  useEffect(() => {
    if (!autoScrollRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      scrollToLatest("auto");
    });
  }, [messages]);

  useEffect(() => {
    if (!streamingPreview || !autoScrollRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      scrollToLatest("auto");
    });
  }, [streamingPreview]);

  useEffect(() => {
    if (!roleMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (!roleMenuRef.current?.contains(target)) {
        setRoleMenuOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setRoleMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [roleMenuOpen]);

  async function sendMessage(rawContent: string) {
    const content = rawContent.trim();
    if ((!content && pendingAttachments.length === 0) || sending || !setupReady) {
      return;
    }

    if (pendingAttachments.length > 0 && !imageInputReady) {
      setErrorMessage(
        "The current chat mode is not ready for image input. Switch to an image-capable provider or remove the image.",
      );
      return;
    }

    setErrorMessage(null);

    const userMessage: ChatMessage = {
      id: `local_${Date.now()}`,
      role: "user",
      authorRole: "user",
      mode,
      content,
      attachments: pendingAttachments,
      createdAt: new Date().toISOString(),
    };
    const nextConversation = [...messages, userMessage];

    setMessages(nextConversation);
    setInput("");
    setPendingAttachments([]);
    setSending(true);
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    setStreamingPreview({
      content: "",
      thinking: "",
      status: mode === "auto" ? "Evaluating route..." : "Waiting for provider...",
      phase: mode === "auto" ? "routing" : "provider",
      providerName: mode === "auto" ? null : activeProvider?.name ?? null,
      role: mode === "auto" ? null : mode,
      modelId:
        mode === "auto"
          ? null
          : activeAssignment?.modelId ?? activeProvider?.config.defaultModelId ?? null,
    });

    try {
      const response = await fetch(clientStreamApiPath("/chat/stream"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mode,
          content: userMessage.content,
          conversation: nextConversation,
          conversationId: conversation?.id ?? selectedConversationId ?? null,
        }),
      });

      if (!response.ok) {
        let message = `Chat request failed with status ${response.status}.`;
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload.message?.trim()) {
            message = payload.message.trim();
          }
        } catch {}
        throw new Error(message);
      }

      if (!response.body) {
        throw new Error("Streaming response body was not available.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            const event = JSON.parse(trimmed) as ChatStreamEvent;
            if (event.type === "status") {
              setStreamingPreview((current) =>
                current
                  ? {
                      ...current,
                      status: event.message,
                      phase: event.phase,
                      providerName: event.providerName ?? current.providerName,
                      role: event.role ?? current.role,
                      modelId: event.modelId ?? current.modelId,
                    }
                  : current,
              );
            } else if (event.type === "thinking") {
              setStreamingPreview((current) =>
                current
                  ? {
                      ...current,
                      thinking: `${current.thinking}${event.text}`,
                    }
                  : current,
              );
            } else if (event.type === "content") {
              setStreamingPreview((current) =>
                current
                  ? {
                      ...current,
                      content: `${current.content}${event.text}`,
                      status: current.status || "Streaming response...",
                    }
                  : current,
              );
            } else if (event.type === "complete") {
              completed = true;
              setStreamingPreview(null);
              setMessages((current) => [...current, event.message]);
              if (event.conversation) {
                setConversation(event.conversation);
              }
              if (event.conversationId) {
                router.replace(`/chat?conversation=${event.conversationId}`);
              }
              announceConversationsChanged();
            } else if (event.type === "error") {
              throw new Error(event.message);
            }
          }
        }

        const trailing = decoder.decode();
        if (trailing.trim()) {
          const event = JSON.parse(trailing.trim()) as ChatStreamEvent;
          if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!completed) {
        throw new Error("Stream ended before the assistant finished responding.");
      }
    } catch (error) {
      setStreamingPreview(null);
      const activeConversationId = conversation?.id ?? selectedConversationId;
      let recovered = false;

      if (activeConversationId) {
        try {
          const snapshot = await fetchConversationSnapshot(activeConversationId);
          if (snapshot && snapshot.messages.length >= nextConversation.length) {
            const { messages: nextMessages, ...summary } = snapshot;
            setConversation(summary);
            setMessages(nextMessages);
            setMode(normalizeMode(snapshot.mode));
            announceConversationsChanged();
            recovered = true;
          }
        } catch {
          // Fall back to the existing error recovery path below.
        }
      }

      if (recovered) {
        setErrorMessage("The live stream disconnected, but the saved response was recovered.");
      } else {
        setMessages((current) => current.filter((message) => message.id !== userMessage.id));
        setInput(userMessage.content);
        setPendingAttachments(userMessage.attachments ?? []);
        setErrorMessage(error instanceof Error ? error.message : "Chat request failed.");
      }
    } finally {
      setSending(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendMessage(input);
  }

  async function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    await sendMessage(input);
  }

  const handleSuggestionClick = (value: string) => {
    setInput(value);
    composerRef.current?.focus();
  };

  const handleAttachmentButtonClick = () => {
    if (!imageInputReady) {
      setErrorMessage(
        "The current chat mode does not have an image-capable provider ready. Connect Anthropic or an OpenAI-compatible provider first.",
      );
      return;
    }

    attachmentInputRef.current?.click();
  };

  const handleAttachmentChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) {
      return;
    }

    setErrorMessage(null);
    const remainingSlots = MAX_IMAGE_ATTACHMENTS - pendingAttachments.length;
    if (remainingSlots <= 0) {
      setErrorMessage(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images per message.`);
      return;
    }

    const acceptedFiles = files.filter((file) => file.type.startsWith("image/")).slice(0, remainingSlots);
    const oversizedFile = acceptedFiles.find((file) => file.size > MAX_IMAGE_BYTES);
    if (oversizedFile) {
      setErrorMessage(`${oversizedFile.name} is too large. Keep each image under 2.5 MB.`);
      return;
    }

    try {
      const attachments = await Promise.all(acceptedFiles.map((file) => readImageAttachment(file)));
      setPendingAttachments((current) => [...current, ...attachments].slice(0, MAX_IMAGE_ATTACHMENTS));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to attach image.");
    }
  };

  const removePendingAttachment = (id: string) => {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  return (
    <section className="chat-page">
      <div className="topbar chat-topbar">
        <div className="chat-topbar-inner">
          <button
            type="button"
            className="icon-btn chat-topbar-toggle"
            onClick={() => window.dispatchEvent(new CustomEvent("toggleSidebar"))}
            aria-label="Toggle sidebar"
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
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="chat-topbar-copy">
            <div className="chat-mode-switch" ref={roleMenuRef}>
              <button
                type="button"
                className={`chat-mode-trigger${roleMenuOpen ? " open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={roleMenuOpen}
                aria-label="Choose active role"
                onClick={() => setRoleMenuOpen((current) => !current)}
              >
                <span className="chat-mode-trigger-label">{getModeLabel(mode)}</span>
                <svg
                  className="chat-mode-caret"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {roleMenuOpen ? (
                <div className="chat-mode-menu" role="menu" aria-label="Chat roles">
                  {modes.map((item) => {
                    const active = item === mode;
                    return (
                      <button
                        key={item}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        className={`chat-mode-option${active ? " active" : ""}`}
                        onClick={() => {
                          setMode(item);
                          setRoleMenuOpen(false);
                        }}
                      >
                        <span>{getModeLabel(item)}</span>
                        {active ? (
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
                            <path d="m20 6-11 11-5-5" />
                          </svg>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
          <div className="topbar-spacer" />
        </div>
      </div>

      {!setupReady ? (
        <div className="notice-strip warning chat-notice">
          {mode === "auto" ? (
            <>
              Open <Link href="/settings">Settings</Link> to connect a provider and assign a model
              to the router role.
            </>
          ) : (
            <>
              Open <Link href="/settings">Settings</Link> to connect a provider and assign a model.
            </>
          )}
        </div>
      ) : null}
      {errorMessage ? <div className="notice-strip danger">{errorMessage}</div> : null}

      <div className="messages-container chat-surface">
        <div ref={messagesScrollRef} className="messages chat-messages">
          {loadingConversation ? <div className="chat-loading">Loading conversation...</div> : null}

          {!loadingConversation && messages.length === 0 ? (
            <div className="chat-empty chat-empty-modern">
              <h1>{greeting}</h1>
              <p>What can I help you with today?</p>
              {setupReady ? (
                <div className="suggestion-grid">
                  {suggestionPrompts.map((prompt) => (
                    <button
                      key={prompt.title}
                      type="button"
                      className="suggestion-card"
                      onClick={() => handleSuggestionClick(prompt.value)}
                    >
                      <h3>{prompt.title}</h3>
                      <p>{prompt.description}</p>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {!loadingConversation &&
            messages.map((message) => (
              <MessageRenderer
                key={message.id}
                message={message}
                humanName={settings.humanName}
              />
            ))}

          {sending && streamingPreview ? (
            <div className="message assistant">
              <div className="message-content">
                <div className="message-header">
                  <span className="message-author">
                    {streamingPreview.providerName || titleCase(streamingPreview.role)}
                  </span>
                </div>

                <ThinkingPanel content={streamingPreview.thinking} live />

                <div className="message-bubble assistant">
                  {streamingPreview.content.trim() ? (
                    <StreamingContent content={streamingPreview.content} />
                  ) : (
                    <span className="streaming-loader" aria-label="Waiting for response" />
                  )}
                </div>
                
                <div className="message-footer">
                  <div className="message-meta-left">
                    {streamingPreview.role && (
                      <span className="message-badge role">{titleCase(streamingPreview.role)}</span>
                    )}
                    {streamingPreview.modelId && (
                      <span className="message-badge model">{streamingPreview.modelId}</span>
                    )}
                    <span className="message-time">{streamingPreview.status}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <form className="composer-wrap" onSubmit={send}>
        {showScrollToBottom && messages.length > 0 && (
          <button
            type="button"
            className="scroll-to-bottom-btn"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          </button>
        )}
        <div className="composer chat-composer">
          <input
            ref={attachmentInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={handleAttachmentChange}
          />
          <div className="composer-main">
            {pendingAttachments.length > 0 ? (
              <div className="composer-attachments">
                {pendingAttachments.map((attachment) => (
                  <div key={attachment.id} className="composer-attachment-chip">
                    <img src={attachment.dataUrl} alt={attachment.name} className="composer-attachment-thumb" />
                    <div className="composer-attachment-copy">
                      <span>{attachment.name}</span>
                    </div>
                    <button
                      type="button"
                      className="composer-attachment-remove"
                      onClick={() => removePendingAttachment(attachment.id)}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              ref={composerRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Ask anything"
              rows={1}
            />
            <div className="composer-toolbar">
              <div className="composer-toolbar-left">
                <button
                  type="button"
                  className="composer-utility"
                  aria-label="Add images"
                  title={imageInputReady ? "Add images" : "Image input needs a compatible provider"}
                  onClick={handleAttachmentButtonClick}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </button>
              </div>
              <div className="composer-toolbar-right">
                <button
                  type="submit"
                  className="composer-send"
                  disabled={
                    sending ||
                    !setupReady ||
                    (!input.trim() && pendingAttachments.length === 0) ||
                    (pendingAttachments.length > 0 && !imageInputReady)
                  }
                  aria-label={sending ? "Sending" : "Send message"}
                >
                  <svg
                    width="19"
                    height="19"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
