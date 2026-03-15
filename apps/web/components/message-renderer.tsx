"use client";

import { Fragment, type ReactNode, useState, useCallback, useEffect, useRef, useMemo } from "react";

import type { ChatAttachment, ChatImageAttachment, ChatMessage, ToolCall } from "@ember/core/client";
import { groupAttachments, isImageAttachment, isTextAttachment } from "../lib/attachments";

type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; code: string; language: string | null }
  | { type: "blockquote"; blocks: MarkdownBlock[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

// Funny loading words that cycle instead of boring "..."
const FUNNY_LOADING_WORDS = [
  "Pondering",
  "Contemplating",
  "Brainstorming",
  "Computing",
  "Calculating",
  "Processing",
  "Deciphering",
  "Analyzing",
  "Synthesizing",
  "Formulating",
  "Constructing",
  "Architecting",
  "Orchestrating",
  "Harmonizing",
  "Wiggling neurons",
  "Consulting the oracle",
  "Summoning ideas",
  "Aligning chakras",
  "Brewing thoughts",
  "Stirring the pot",
  "Connecting dots",
  "Chasing rabbits",
  "Herding cats",
  "Warming up tensors",
  "Polishing bits",
  "Feeding hamsters",
  "Untangling strings",
  "Bribing electrons",
  "Tickling circuits",
  "Convincing pixels",
];

function formatMessageTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  
  if (isToday) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function isUnorderedListLine(line: string): boolean {
  return /^[-*+]\s+/.test(line.trim());
}

function isOrderedListLine(line: string): boolean {
  return /^\d+\.\s+/.test(line.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  // Handle both "|------|------|" and "------|------" formats
  const withoutPipes = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return /^:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*$/.test(withoutPipes);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableStart(lines: string[], index: number): boolean {
  return index + 1 < lines.length && lines[index].includes("|") && isTableSeparator(lines[index + 1]);
}

function isBlockBoundary(lines: string[], index: number): boolean {
  const line = lines[index];
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    /^```/.test(trimmed) ||
    /^(#{1,6})\s+/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    isUnorderedListLine(trimmed) ||
    isOrderedListLine(trimmed) ||
    isTableStart(lines, index)
  );
}

function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fenceMatch = trimmed.match(/^```([\w.-]+)?\s*$/);
    if (fenceMatch) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        type: "code",
        code: codeLines.join("\n"),
        language: fenceMatch[1] ?? null,
      });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }

      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({
        type: "blockquote",
        blocks: parseMarkdown(quoteLines.join("\n")),
      });
      continue;
    }

    if (isUnorderedListLine(trimmed) || isOrderedListLine(trimmed)) {
      const ordered = isOrderedListLine(trimmed);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        if (!current) {
          break;
        }
        if (ordered && !isOrderedListLine(current)) {
          break;
        }
        if (!ordered && !isUnorderedListLine(current)) {
          break;
        }
        items.push(current.replace(ordered ? /^\d+\.\s+/ : /^[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isBlockBoundary(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({
      type: "paragraph",
      text: paragraphLines.join(" "),
    });
  }

  return blocks;
}

function splitAutoLink(url: string): { href: string; trailing: string } {
  const match = url.match(/^(.*?)([.,!?;:]*)$/);
  if (!match) {
    return { href: url, trailing: "" };
  }

  return {
    href: match[1],
    trailing: match[2] ?? "",
  };
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const tokenPattern =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\)|https?:\/\/[^\s<]+)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = tokenPattern.exec(text);

  while (match) {
    const [token] = match;
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={`code-${match.index}`}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={`strong-${match.index}`}>
          {renderInlineMarkdown(token.slice(2, -2))}
        </strong>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <em key={`em-${match.index}`}>
          {renderInlineMarkdown(token.slice(1, -1))}
        </em>,
      );
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((.+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a
            key={`link-${match.index}`}
            href={linkMatch[2]}
            target="_blank"
            rel="noreferrer"
          >
            {linkMatch[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else {
      const { href, trailing } = splitAutoLink(token);
      nodes.push(
        <Fragment key={`url-${match.index}`}>
          <a href={href} target="_blank" rel="noreferrer">
            {href}
          </a>
          {trailing}
        </Fragment>,
      );
    }

    lastIndex = match.index + token.length;
    match = tokenPattern.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderBlocks(blocks: MarkdownBlock[], keyPrefix = "block"): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (block.type) {
      case "heading": {
        const HeadingTag = `h${Math.min(block.level, 3)}` as "h1" | "h2" | "h3";
        return <HeadingTag key={key}>{renderInlineMarkdown(block.text)}</HeadingTag>;
      }
      case "paragraph":
        return <p key={key}>{renderInlineMarkdown(block.text)}</p>;
      case "code":
        return (
          <pre key={key}>
            <code data-language={block.language ?? undefined}>{block.code}</code>
          </pre>
        );
      case "blockquote":
        return <blockquote key={key}>{renderBlocks(block.blocks, key)}</blockquote>;
      case "list": {
        const ListTag = block.ordered ? "ol" : "ul";
        return (
          <ListTag key={key}>
            {block.items.map((item, itemIndex) => (
              <li key={`${key}-item-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
            ))}
          </ListTag>
        );
      }
      case "table":
        return (
          <div key={key} className="table-wrap">
            <table>
              <thead>
                <tr>
                  {block.headers.map((header, headerIndex) => (
                    <th key={`${key}-header-${headerIndex}`}>{renderInlineMarkdown(header)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`${key}-row-${rowIndex}`}>
                    {row.map((cell, cellIndex) => (
                      <td key={`${key}-cell-${rowIndex}-${cellIndex}`}>
                        {renderInlineMarkdown(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return null;
    }
  });
}

export function MessageContent({ content }: { content: string }) {
  return <div className="message-markdown">{renderBlocks(parseMarkdown(content))}</div>;
}

/**
 * Parse streaming content into blocks, handling partial/incomplete content gracefully.
 * Unlike parseMarkdown, this doesn't wait for complete blocks - it formats what it can
 * and renders partial blocks as plain text with inline formatting.
 */
function parseStreamingMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    // Code block - only render if we see the closing fence
    const fenceMatch = trimmed.match(/^```([\w.-]+)?\s*$/);
    if (fenceMatch) {
      index += 1;
      const codeLines: string[] = [];
      let closed = false;
      while (index < lines.length) {
        if (lines[index].trim().startsWith("```")) {
          closed = true;
          index += 1;
          break;
        }
        codeLines.push(lines[index]);
        index += 1;
      }
      // Only add as code block if closed, otherwise treat as plain text
      if (closed) {
        blocks.push({
          type: "code",
          code: codeLines.join("\n"),
          language: fenceMatch[1] ?? null,
        });
      } else {
        // Partial code block - render as plain text with backticks
        blocks.push({
          type: "paragraph",
          text: "```" + (fenceMatch[1] ?? "") + "\n" + codeLines.join("\n"),
        });
      }
      continue;
    }

    // Heading - always safe to render immediately
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    // Table - only render if we have header + separator + at least one row
    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      const rows: string[][] = [];
      index += 2; // Skip header and separator

      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }

      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({
        type: "blockquote",
        blocks: parseStreamingMarkdown(quoteLines.join("\n")),
      });
      continue;
    }

    // List - render what we have so far, even if incomplete
    if (isUnorderedListLine(trimmed) || isOrderedListLine(trimmed)) {
      const ordered = isOrderedListLine(trimmed);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        if (!current) {
          break;
        }
        // Check if next line starts a new list item
        if (ordered && !isOrderedListLine(current) && !current.startsWith(" ")) {
          break;
        }
        if (!ordered && !isUnorderedListLine(current) && !current.startsWith(" ")) {
          break;
        }
        items.push(current.replace(ordered ? /^\d+\.\s+/ : /^[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph - accumulate lines until we hit a block boundary
    const paragraphLines: string[] = [];
    while (index < lines.length && !isBlockBoundary(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push({
        type: "paragraph",
        text: paragraphLines.join(" "),
      });
    }
  }

  return blocks;
}

/**
 * Used during streaming. Formats markdown live while handling partial content gracefully.
 * - Renders complete blocks (closed code fences, complete tables) with full formatting
 * - Renders incomplete blocks as plain text with inline formatting
 * - Always applies inline formatting (bold, italic, code, links)
 */
export function StreamingContent({ content }: { content: string }) {
  const blocks = parseStreamingMarkdown(content);
  return <div className="message-markdown">{renderBlocks(blocks, "stream")}</div>;
}

// Funny cycling loader that shows random words instead of boring "..."
export function FunnyLoader({ className = "" }: { className?: string }) {
  const [wordIndex, setWordIndex] = useState(() => Math.floor(Math.random() * FUNNY_LOADING_WORDS.length));
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const wordInterval = setInterval(() => {
      setIsVisible(false);
      setTimeout(() => {
        setWordIndex((prev) => (prev + 1) % FUNNY_LOADING_WORDS.length);
        setIsVisible(true);
      }, 150);
    }, 2000);

    return () => clearInterval(wordInterval);
  }, []);

  return (
    <span 
      className={`funny-loader ${className}`}
      style={{ 
        opacity: isVisible ? 1 : 0,
        transition: "opacity 150ms ease"
      }}
    >
      {FUNNY_LOADING_WORDS[wordIndex]}
    </span>
  );
}

// Format thinking content - add newlines after periods if missing
function formatThinkingContent(content: string): string {
  // First, normalize any existing newlines
  let formatted = content.replace(/\r\n/g, '\n');
  
  // Add newlines after periods that are followed by capital letters (likely sentence boundaries)
  // This handles cases where sentences run together: "...there.The page..."
  formatted = formatted.replace(/\.(?=[A-Z])/g, '.\n');
  
  // Also add newlines after periods followed by quotes and capital letters
  formatted = formatted.replace(/\."(?=[A-Z])/g, '."\n');
  
  return formatted;
}

// Collapsible panel for thinking content
export function ThinkingPanel({
  content,
  live = false,
}: {
  content: string;
  live?: boolean;
}) {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const formattedContent = formatThinkingContent(trimmed);

  return (
    <details className={`reasoning-panel${live ? " live" : ""}`} open={live}>
      <summary>
        <div className="reasoning-panel-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
            <path d="M8.5 8.5A9.9 9.9 0 0 0 12 21a9.9 9.9 0 0 0 3.5-12.5" />
          </svg>
          <span>Thinking</span>
        </div>
        {live ? <span className="reasoning-live-badge">Live</span> : null}
        <div className="reasoning-chevron">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </summary>
      <div className="reasoning-panel-body">
        <pre className="reasoning-content">{formattedContent}</pre>
      </div>
    </details>
  );
}

// Tool call badge/icon mapping
const TOOL_ICONS: Record<string, string> = {
  search: "🔍",
  read: "📄",
  write: "✏️",
  edit: "📝",
  fetch: "🌐",
  terminal: "💻",
  bash: "⚡",
  git: "🌿",
  file: "📁",
  default: "🔧",
};

function getToolIcon(name: string): string {
  for (const [key, icon] of Object.entries(TOOL_ICONS)) {
    if (name.toLowerCase().includes(key)) return icon;
  }
  return TOOL_ICONS.default;
}

function formatDuration(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const duration = end - start;
  
  if (duration < 1000) return `${duration}ms`;
  return `${(duration / 1000).toFixed(1)}s`;
}

// Individual tool call item
function ToolCallItem({ tool, defaultOpen = false }: { tool: ToolCall; defaultOpen?: boolean }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const isRunning = tool.status === "running" || tool.status === "pending";
  const isError = tool.status === "error";
  const isComplete = tool.status === "complete";

  return (
    <div className={`tool-call-item ${tool.status}`}>
      <button 
        className="tool-call-header"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="tool-call-icon">
          {isRunning ? (
            <span className="tool-spinner" />
          ) : (
            <span>{getToolIcon(tool.name)}</span>
          )}
        </div>
        <div className="tool-call-info">
          <span className="tool-call-name">{tool.name}</span>
          <span className="tool-call-status">
            {isRunning && "Running..."}
            {isComplete && `Done in ${formatDuration(tool.startedAt, tool.endedAt)}`}
            {isError && "Failed"}
          </span>
        </div>
        <div className={`tool-call-chevron ${isOpen ? "open" : ""}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </button>
      
      {isOpen && (
        <div className="tool-call-body">
          <div className="tool-call-section">
            <div className="tool-call-section-title">Arguments</div>
            <pre className="tool-call-code">
              {JSON.stringify(tool.arguments, null, 2)}
            </pre>
          </div>
          {tool.result && (
            <div className="tool-call-section">
              <div className="tool-call-section-title">Result</div>
              <pre className={`tool-call-code ${isError ? "error" : ""}`}>
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Collapsible panel for tool calls
export function ToolCallsPanel({
  tools,
  live = false,
}: {
  tools: ToolCall[];
  live?: boolean;
}) {
  if (tools.length === 0) {
    return null;
  }

  const runningCount = tools.filter((t) => t.status === "running" || t.status === "pending").length;
  const completedCount = tools.filter((t) => t.status === "complete").length;
  const errorCount = tools.filter((t) => t.status === "error").length;

  return (
    <details className={`tools-panel${live ? " live" : ""}`} open={live}>
      <summary>
        <div className="tools-panel-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
          <span>Tools</span>
          <span className="tools-count">
            {tools.length} {tools.length === 1 ? "call" : "calls"}
          </span>
          {runningCount > 0 && (
            <span className="tools-status running">{runningCount} running</span>
          )}
          {errorCount > 0 && !live && (
            <span className="tools-status error">{errorCount} failed</span>
          )}
        </div>
        <div className="tools-chevron">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </summary>
      <div className="tools-panel-body">
        {tools.map((tool) => (
          <ToolCallItem key={tool.id} tool={tool} defaultOpen={live && tool.status === "running"} />
        ))}
      </div>
    </details>
  );
}

// Live elapsed timer that ticks every second
export function ElapsedTimer({ startedAt, endedAt }: { startedAt: string; endedAt?: string }) {
  const [now, setNow] = useState(Date.now());
  const isLive = !endedAt;

  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isLive]);

  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now;
  const elapsed = Math.max(0, end - start);

  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  let display: string;
  if (hours > 0) {
    display = `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    display = `${minutes}m ${seconds % 60}s`;
  } else {
    display = `${seconds}s`;
  }

  return (
    <span className={`elapsed-timer${isLive ? " live" : ""}`}>
      {isLive && <span className="elapsed-timer-dot" />}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <span>{display}</span>
    </span>
  );
}

// Combined panel for thinking + tool calls + intermediate content - keeps all agent internals in one box
export function AgentActivityPanel({
  thinking,
  intermediateContent,
  toolCalls,
  live = false,
}: {
  thinking: string;
  /** Content from intermediate tool-use turns (shown inside the panel instead of the main bubble) */
  intermediateContent?: string;
  toolCalls: ToolCall[];
  live?: boolean;
}) {
  const hasThinking = thinking.trim().length > 0;
  const hasTools = toolCalls.length > 0;
  const hasIntermediate = (intermediateContent ?? "").trim().length > 0;

  if (!hasThinking && !hasTools && !hasIntermediate) return null;

  const runningCount = toolCalls.filter((t) => t.status === "running" || t.status === "pending").length;
  const completedCount = toolCalls.filter((t) => t.status === "complete").length;
  const errorCount = toolCalls.filter((t) => t.status === "error").length;
  const formattedThinking = hasThinking ? formatThinkingContent(thinking.trim()) : "";

  return (
    <details className={`activity-panel${live ? " live" : ""}`} open={live}>
      <summary>
        <div className="activity-panel-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
            <path d="M8.5 8.5A9.9 9.9 0 0 0 12 21a9.9 9.9 0 0 0 3.5-12.5" />
          </svg>
          <span>Agent Activity</span>
          {hasTools && (
            <span className="activity-stats">
              {completedCount > 0 && <span className="activity-stat done">{completedCount} done</span>}
              {runningCount > 0 && <span className="activity-stat running">{runningCount} running</span>}
              {errorCount > 0 && <span className="activity-stat error">{errorCount} failed</span>}
              {!runningCount && !errorCount && !completedCount && (
                <span className="activity-stat">{toolCalls.length} {toolCalls.length === 1 ? "tool" : "tools"}</span>
              )}
            </span>
          )}
          {live && <span className="activity-live-badge">Live</span>}
        </div>
        <div className="activity-chevron">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </summary>
      <div className="activity-panel-body">
        {/* Thinking section */}
        {hasThinking && (
          <div className="activity-section">
            <div className="activity-section-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
              </svg>
              Reasoning
            </div>
            <pre className="activity-thinking">{formattedThinking}</pre>
          </div>
        )}
        {/* Intermediate content from tool-use turns */}
        {hasIntermediate && (
          <div className="activity-section">
            <div className="activity-section-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Intermediate Output
            </div>
            <div className="activity-intermediate">
              <MessageContent content={intermediateContent!.trim()} />
            </div>
          </div>
        )}
        {/* Tool calls section */}
        {hasTools && (
          <div className="activity-section">
            <div className="activity-section-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
              Tool Calls
            </div>
            <div className="activity-tools">
              {toolCalls.map((tool) => (
                <ToolCallItem key={tool.id} tool={tool} defaultOpen={live && tool.status === "running"} />
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

// Format token count for display (e.g. 1234 → "1.2k", 12345 → "12.3k")
function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

// Token usage display
export function TokenBadge({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }) {
  if (inputTokens === 0 && outputTokens === 0) return null;

  const total = inputTokens + outputTokens;

  return (
    <span
      className="token-badge"
      title={`Input: ${inputTokens.toLocaleString()} tokens\nOutput: ${outputTokens.toLocaleString()} tokens\nTotal: ${total.toLocaleString()} tokens`}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.2 7.8l-7.7 7.7-4-4-5.7 5.7" />
        <path d="M15 7h6v6" />
      </svg>
      <span className="token-badge-group">
        <span className="token-badge-in" title="Input tokens">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
          {formatTokenCount(inputTokens)}
        </span>
        <span className="token-badge-out" title="Output tokens">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
          {formatTokenCount(outputTokens)}
        </span>
      </span>
      <span className="token-badge-total" title="Total tokens">
        {formatTokenCount(total)}
      </span>
    </span>
  );
}

function ImageAttachments({ attachments }: { attachments: ChatImageAttachment[] }) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="message-attachments">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="message-attachment">
          <img src={attachment.dataUrl} alt={attachment.name} className="message-attachment-image" />
        </div>
      ))}
    </div>
  );
}

function TextAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) {
    return null;
  }

  const groups = groupAttachments(attachments);

  return (
    <div className="message-file-list">
      {groups.map((group) => {
        const textAttachments = group.attachments.filter(isTextAttachment);
        if (textAttachments.length === 0) {
          return null;
        }

        return (
          <details key={group.sourceId} className="message-file-card">
            <summary className="message-file-summary">
              <span className="message-file-name">{group.sourceName}</span>
              <span className="message-file-meta">{group.summary}</span>
            </summary>
            <div className="message-file-body">
              {textAttachments.map((attachment) => (
                <div key={attachment.id} className="message-file-preview">
                  <div className="message-file-preview-header">
                    <span>{attachment.language ? `.${attachment.language}` : attachment.mediaType}</span>
                    {attachment.truncated ? <span>truncated</span> : null}
                  </div>
                  <pre>
                    <code>{attachment.text}</code>
                  </pre>
                </div>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore copy errors
    }
  }, [content]);

  return (
    <button
      type="button"
      className="message-action-btn"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied!" : "Copy message"}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function MessageRenderer({
  message,
  humanName,
}: {
  message: ChatMessage;
  humanName?: string | null;
}) {
  const isUser = message.role === "user";
  const author = isUser ? humanName?.trim() || "You" : message.providerName || "Ember";

  // Get role label (e.g., "Director", "Coordinator")
  const roleLabel = !isUser && message.authorRole !== "user"
    ? `${message.authorRole.slice(0, 1).toUpperCase()}${message.authorRole.slice(1)}`
    : null;

  // Get model label
  const modelLabel = !isUser ? message.modelId?.trim() ?? null : null;

  const imageAttachments = (message.attachments ?? []).filter(isImageAttachment);
  const textAttachments = (message.attachments ?? []).filter(isTextAttachment);

  // Calculate response duration from tool calls or message timing
  const responseDuration = useMemo(() => {
    if (isUser) return null;
    const tools = message.toolCalls ?? [];
    if (tools.length === 0) return null;
    const starts = tools.map(t => new Date(t.startedAt).getTime()).filter(t => !isNaN(t));
    const ends = tools.filter(t => t.endedAt).map(t => new Date(t.endedAt!).getTime()).filter(t => !isNaN(t));
    if (starts.length === 0) return null;
    const earliest = Math.min(...starts);
    const latest = ends.length > 0 ? Math.max(...ends) : new Date(message.createdAt).getTime();
    const dur = latest - earliest;
    if (dur < 1000) return `${dur}ms`;
    if (dur < 60000) return `${(dur / 1000).toFixed(1)}s`;
    const mins = Math.floor(dur / 60000);
    const secs = Math.floor((dur % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }, [isUser, message.toolCalls, message.createdAt]);

  const hasActivity = !isUser && ((message.thinking ?? "").trim().length > 0 || (message.toolCalls ?? []).length > 0);

  return (
    <div className={`message ${isUser ? "user" : "assistant"}`}>
      <div className="message-content">
        {/* Header with author name and role/model badges */}
        <div className="message-header">
          <span className="message-author">{author}</span>
          {!isUser && roleLabel && (
            <span className="message-badge role">{roleLabel}</span>
          )}
          {!isUser && modelLabel && (
            <span className="message-badge model">{modelLabel}</span>
          )}
        </div>

        {/* Combined activity panel (thinking + tool calls) */}
        {hasActivity && (
          <AgentActivityPanel
            thinking={message.thinking ?? ""}
            toolCalls={message.toolCalls ?? []}
          />
        )}

        {/* Message bubble - final response only */}
        <div className={`message-bubble ${isUser ? "user" : "assistant"}`}>
          <ImageAttachments attachments={imageAttachments} />
          <TextAttachments attachments={textAttachments} />
          <MessageContent content={message.content} />
        </div>

        {/* Footer with time, duration, tokens, and copy button */}
        <div className="message-footer">
          <div className="message-meta-left">
            <span className="message-time">{formatMessageTime(message.createdAt)}</span>
            {responseDuration && (
              <span className="message-duration">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                {responseDuration}
              </span>
            )}
            {!isUser && message.usage && (
              <TokenBadge inputTokens={message.usage.inputTokens} outputTokens={message.usage.outputTokens} />
            )}
          </div>
          <div className="message-meta-right">
            <CopyButton content={message.content} />
          </div>
        </div>
      </div>
    </div>
  );
}
