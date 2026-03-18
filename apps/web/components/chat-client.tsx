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
  ChatAttachmentUpload,
  ChatMessage,
  ChatMode,
  ChatStreamEvent,
  Conversation,
  ConversationSummary,
  PreparedAttachmentGroup,
  Provider,
  RoleAssignment,
  Settings,
  SimulationStreamEvent,
  ToolCall,
} from "@ember/core/client";
import { ROLES } from "@ember/core/client";

import { flattenAttachmentGroups, groupAttachments, isImageAttachment } from "../lib/attachments";
import { clientApiPath, clientStreamApiPath } from "../lib/api";
import { announceConversationsChanged } from "../lib/conversations";
import {
  getDeterministicSuggestionPrompts,
  getRandomSuggestionPrompts,
  type SuggestionPrompt,
} from "../lib/suggestion-prompts";
import { AgentActivityPanel, CopyButton, ElapsedTimer, FunnyLoader, MessageRenderer, StreamingContent, TokenBadge } from "./message-renderer";
import { LiveSimulation } from "./live-simulation";
import { ChatSimulationDock } from "./chat-simulation-dock";

const directModes = ROLES.filter((role) => role !== "dispatch" && role !== "coordinator" && role !== "ops");
const modes = ["auto", "coordinator", ...directModes] as const;
const MAX_ATTACHMENT_FILES = 6;
const MAX_ATTACHMENT_FILE_BYTES = 8 * 1024 * 1024;

function normalizeMode(mode: ChatMode): (typeof modes)[number] {
  if (mode === "dispatch" || mode === "ops") {
    return "auto";
  }
  return mode;
}



interface StreamingPreview {
  content: string;
  thinking: string;
  /** Intermediate content from tool-use turns that should be shown in the activity panel, not the main bubble */
  intermediateContent: string;
  status: string;
  phase: "routing" | "provider" | "streaming" | "saving";
  providerName: string | null;
  role: string | null;
  modelId: string | null;
  toolCalls: ToolCall[];
  simulationEvents: SimulationStreamEvent[];
  startedAt: string;
  inputTokens: number;
  outputTokens: number;
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

function readUpload(file: File): Promise<ChatAttachmentUpload> {
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
        name: file.name,
        mediaType: file.type || "application/octet-stream",
        dataUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

function hasImageAttachments(attachments: ChatAttachment[]): boolean {
  return attachments.some((attachment) => isImageAttachment(attachment));
}

export function decodeStreamBuffer(buffer: string): { events: ChatStreamEvent[]; rest: string } {
  const usesSse =
    buffer.startsWith("data:") ||
    buffer.startsWith(":") ||
    buffer.includes("\n\ndata:") ||
    buffer.includes("\n\n:");

  if (usesSse) {
    const blocks = buffer.split("\n\n");
    const rest = blocks.pop() ?? "";
    const events: ChatStreamEvent[] = [];

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed || trimmed.startsWith(":")) {
        continue;
      }

      const data = trimmed
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("");
      if (!data) {
        continue;
      }

      events.push(JSON.parse(data) as ChatStreamEvent);
    }

    return { events, rest };
  }

  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChatStreamEvent);

  return { events, rest };
}

export function validateAttachmentSelection(
  files: Array<{ name: string; size: number }>,
  existingAttachmentCount: number,
  limits: {
    maxFiles?: number;
    maxBytes?: number;
  } = {},
): {
  acceptedCount: number;
  error: string | null;
} {
  const maxFiles = limits.maxFiles ?? MAX_ATTACHMENT_FILES;
  const maxBytes = limits.maxBytes ?? MAX_ATTACHMENT_FILE_BYTES;
  const remainingSlots = maxFiles - existingAttachmentCount;
  if (remainingSlots <= 0) {
    return {
      acceptedCount: 0,
      error: `You can attach up to ${maxFiles} files per message.`,
    };
  }

  const acceptedCount = Math.max(0, Math.min(files.length, remainingSlots));
  const oversizedFile = files.slice(0, acceptedCount).find((file) => file.size > maxBytes);
  if (oversizedFile) {
    return {
      acceptedCount: 0,
      error: `${oversizedFile.name} is too large. Keep each file under 8 MB.`,
    };
  }

  return {
    acceptedCount,
    error: null,
  };
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
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [preparingAttachmentNames, setPreparingAttachmentNames] = useState<string[]>([]);
  const [pendingAttachmentGroups, setPendingAttachmentGroups] = useState<PreparedAttachmentGroup[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const roleMenuRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const autoScrollRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [suggestionPrompts, setSuggestionPrompts] = useState<SuggestionPrompt[]>(() =>
    getDeterministicSuggestionPrompts(4),
  );

  const scrollToLatest = (behavior: ScrollBehavior = "auto", retries = 3) => {
    const scrollEl = messagesScrollRef.current;
    
    if (!scrollEl) return;

    const tryScroll = (attempt: number) => {
      const targetScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      scrollEl.scrollTop = targetScroll;
      
      // Retry if not at bottom and we have retries left
      if (scrollEl.scrollTop < targetScroll - 5 && attempt > 0) {
        setTimeout(() => tryScroll(attempt - 1), 50);
      }
    };
    
    // Immediate scroll
    tryScroll(retries);
    
    // And another after a frame to catch any layout shifts
    requestAnimationFrame(() => {
      tryScroll(retries);
    });
  };

  const assignmentMap = useMemo(
    () => new Map(assignments.map((assignment) => [assignment.role, assignment])),
    [assignments],
  );
  const pendingAttachments = useMemo(
    () => flattenAttachmentGroups(pendingAttachmentGroups),
    [pendingAttachmentGroups],
  );
  const pendingContainsImages = useMemo(
    () => hasImageAttachments(pendingAttachments),
    [pendingAttachments],
  );

  useEffect(() => {
    setSuggestionPrompts(getRandomSuggestionPrompts(4));
  }, []);

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
      setPendingAttachmentGroups([]);
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

  // Scroll when messages change (but not during streaming since that has its own handler)
  useEffect(() => {
    if (loadingConversation || streamingPreview) {
      return;
    }

    if (messages.length === 0) {
      return;
    }

    scrollToLatest("instant");
  }, [selectedConversationId, loadingConversation, messages.length, streamingPreview]);

  useEffect(() => {
    if (!autoScrollRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      scrollToLatest("auto");
    });
  }, [messages]);

  // Auto-scroll during streaming - always scroll to show latest content
  useEffect(() => {
    if (!streamingPreview) {
      return;
    }

    // Always scroll during streaming, regardless of user scroll position
    scrollToLatest("instant");
  });

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
    if ((!content && pendingAttachments.length === 0) || sending || preparingAttachments || !setupReady) {
      return;
    }

    if (pendingContainsImages && !imageInputReady) {
      setErrorMessage(
        "One or more attachments include images. Switch to an image-capable provider or remove the image-based attachment.",
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
    setPendingAttachmentGroups([]);
    setSending(true);
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    
    // Force scroll to bottom immediately after user message is added
    scrollToLatest("instant");
    
    setStreamingPreview({
      content: "",
      thinking: "",
      intermediateContent: "",
      status: mode === "auto" ? "Evaluating route..." : "Waiting for provider...",
      phase: mode === "auto" ? "routing" : "provider",
      providerName: mode === "auto" ? null : activeProvider?.name ?? null,
      role: mode === "auto" ? null : mode,
      modelId:
        mode === "auto"
          ? null
          : activeAssignment?.modelId ?? activeProvider?.config.defaultModelId ?? null,
      toolCalls: [],
      simulationEvents: [],
      startedAt: new Date().toISOString(),
      inputTokens: 0,
      outputTokens: 0,
    });

    try {
      const response = await fetch(clientStreamApiPath("/chat/stream"), {
        method: "POST",
        headers: {
          accept: "text/event-stream",
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
      const applyStreamEvent = (event: ChatStreamEvent) => {
        if (event.type === "status") {
          setStreamingPreview((current) => {
            if (!current) return current;
            // When the server signals a tool call (status starts with "Tool:")
            // or tool-loop compaction, move any accumulated content into
            // intermediateContent so it shows inside the activity panel
            // instead of the main response bubble.
            const isToolStatus = event.message.startsWith("Tool:") || event.message.startsWith("Compacting tool-loop");
            const movedContent = isToolStatus && current.content.trim()
              ? current.intermediateContent + current.content
              : current.intermediateContent;
            return {
              ...current,
              status: event.message,
              phase: event.phase,
              providerName: event.providerName ?? current.providerName,
              role: event.role ?? current.role,
              modelId: event.modelId ?? current.modelId,
              intermediateContent: movedContent,
              content: isToolStatus && current.content.trim() ? "" : current.content,
            };
          });
        } else if (event.type === "thinking") {
          setStreamingPreview((current) =>
            current
              ? {
                  ...current,
                  thinking: `${current.thinking}${event.text}`,
                }
              : current,
          );
        } else if (event.type === "toolCall") {
          setStreamingPreview((current) => {
            if (!current) return current;
            const existingIndex = current.toolCalls.findIndex((t) => t.id === event.toolCall.id);
            if (existingIndex >= 0) {
              const updated = [...current.toolCalls];
              updated[existingIndex] = event.toolCall;
              return { ...current, toolCalls: updated };
            }
            return { ...current, toolCalls: [...current.toolCalls, event.toolCall] };
          });
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
        } else if (event.type === "simulation") {
          setStreamingPreview((current) =>
            current
              ? {
                  ...current,
                  simulationEvents: [...current.simulationEvents, event.event],
                }
              : current,
          );
        } else if (event.type === "usage") {
          setStreamingPreview((current) =>
            current
              ? {
                  ...current,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
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
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const decoded = decodeStreamBuffer(buffer);
          buffer = decoded.rest;

          for (const event of decoded.events) {
            applyStreamEvent(event);
          }
        }

        const trailing = decoder.decode();
        if (trailing.trim()) {
          buffer += trailing;
        }

        if (buffer.trim()) {
          const decoded = decodeStreamBuffer(`${buffer}\n\n`);
          for (const event of decoded.events) {
            applyStreamEvent(event);
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
        setPendingAttachmentGroups(groupAttachments(userMessage.attachments ?? []));
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
    setErrorMessage(null);
    attachmentInputRef.current?.click();
  };

  const handleAttachmentChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) {
      return;
    }

    setErrorMessage(null);
    const validation = validateAttachmentSelection(files, pendingAttachmentGroups.length);
    if (validation.error) {
      setErrorMessage(validation.error);
      return;
    }

    const acceptedFiles = files.slice(0, validation.acceptedCount);
    if (acceptedFiles.length === 0) {
      return;
    }

    try {
      setPreparingAttachments(true);
      setPreparingAttachmentNames(acceptedFiles.map((file) => file.name));
      const uploads = await Promise.all(acceptedFiles.map((file) => readUpload(file)));
      const response = await fetch(clientApiPath("/chat/attachments/prepare"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ uploads }),
      });

      if (!response.ok) {
        let message = `Attachment preparation failed with status ${response.status}.`;
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload.message?.trim()) {
            message = payload.message.trim();
          }
        } catch {}
        throw new Error(message);
      }

      const payload = (await response.json()) as { groups: PreparedAttachmentGroup[] };
      const warnings = payload.groups.flatMap((group) => group.warnings ?? []);
      setPendingAttachmentGroups((current) =>
        [...current, ...payload.groups].slice(0, MAX_ATTACHMENT_FILES),
      );
      if (warnings.length > 0) {
        setErrorMessage(warnings.join(" "));
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to attach file.");
    } finally {
      setPreparingAttachments(false);
      setPreparingAttachmentNames([]);
    }
  };

  const removePendingAttachmentGroup = (sourceId: string) => {
    setPendingAttachmentGroups((current) =>
      current.filter((group) => group.sourceId !== sourceId),
    );
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
            <div className="message assistant streaming">
              <div className="message-content">
                <div className="message-header">
                  <span className="message-author">
                    {streamingPreview.providerName || titleCase(streamingPreview.role)}
                  </span>
                  {streamingPreview.role && (
                    <span className="message-badge role">{titleCase(streamingPreview.role)}</span>
                  )}
                  {streamingPreview.modelId && (
                    <span className="message-badge model">{streamingPreview.modelId}</span>
                  )}
                </div>

                {/* Combined activity panel: thinking + intermediate content + tools */}
                <AgentActivityPanel
                  thinking={streamingPreview.thinking}
                  intermediateContent={streamingPreview.intermediateContent}
                  toolCalls={streamingPreview.toolCalls}
                  live
                />

                {/* Live simulation visualization */}
                {streamingPreview.simulationEvents.length > 0 && (
                  <LiveSimulation events={streamingPreview.simulationEvents} />
                )}

                {/* Only show the final response content in the bubble */}
                <div className="message-bubble assistant">
                  {streamingPreview.content.trim() ? (
                    <StreamingContent content={streamingPreview.content} />
                  ) : (
                    <div className="streaming-waiting">
                      <FunnyLoader />
                    </div>
                  )}
                </div>

                <div className="message-footer">
                  <div className="message-meta-left">
                    <span className="message-time">{streamingPreview.status}</span>
                    <ElapsedTimer startedAt={streamingPreview.startedAt} />
                    <TokenBadge inputTokens={streamingPreview.inputTokens} outputTokens={streamingPreview.outputTokens} />
                  </div>
                  <div className="message-meta-right">
                    {streamingPreview.content.trim() && (
                      <CopyButton content={streamingPreview.content} />
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <ChatSimulationDock />

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
            multiple
            hidden
            onChange={handleAttachmentChange}
          />
          <div className="composer-main">
            {pendingAttachmentGroups.length > 0 || preparingAttachmentNames.length > 0 ? (
              <div className="composer-attachments">
                {pendingAttachmentGroups.map((group) => {
                  const previewImage = group.attachments.find(isImageAttachment);
                  return (
                    <div key={group.sourceId} className="composer-attachment-chip">
                      {previewImage ? (
                        <img
                          src={previewImage.dataUrl}
                          alt={group.sourceName}
                          className="composer-attachment-thumb"
                        />
                      ) : (
                        <div className="composer-attachment-thumb composer-attachment-icon">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <path d="M14 2v6h6" />
                          </svg>
                        </div>
                      )}
                      <div className="composer-attachment-copy">
                        <span>{group.sourceName}</span>
                        <span>{group.summary}</span>
                      </div>
                      <button
                        type="button"
                        className="composer-attachment-remove"
                        onClick={() => removePendingAttachmentGroup(group.sourceId)}
                        aria-label={`Remove ${group.sourceName}`}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
                {preparingAttachmentNames.map((name, index) => (
                  <div
                    key={`preparing-${name}-${index}`}
                    className="composer-attachment-chip composer-attachment-chip-loading"
                    aria-live="polite"
                  >
                    <div className="composer-attachment-thumb composer-attachment-icon composer-attachment-spinner">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 12a9 9 0 1 1-6.22-8.56" />
                      </svg>
                    </div>
                    <div className="composer-attachment-copy">
                      <span>{name}</span>
                      <span>Preparing attachment...</span>
                    </div>
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
                  aria-label="Add files"
                  title={preparingAttachments ? "Preparing files..." : "Add files"}
                  onClick={handleAttachmentButtonClick}
                  disabled={preparingAttachments}
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
                    preparingAttachments ||
                    !setupReady ||
                    (!input.trim() && pendingAttachments.length === 0) ||
                    (pendingContainsImages && !imageInputReady)
                  }
                  aria-label={sending || preparingAttachments ? "Sending" : "Send message"}
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
