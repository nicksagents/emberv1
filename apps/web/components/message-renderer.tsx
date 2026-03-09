import { Fragment, type ReactNode } from "react";

import type { ChatAttachment, ChatMessage } from "@ember/core/client";

type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; code: string; language: string | null }
  | { type: "blockquote"; blocks: MarkdownBlock[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function isUnorderedListLine(line: string): boolean {
  return /^[-*+]\s+/.test(line.trim());
}

function isOrderedListLine(line: string): boolean {
  return /^\d+\.\s+/.test(line.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+$/.test(trimmed);
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
  const match = url.match(/^(.*?)([.,!?;:)]*)$/);
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

  return (
    <details className={`thinking-panel${live ? " live" : ""}`} open={live ? true : undefined}>
      <summary>
        <span>Thinking</span>
        {live ? <span className="thinking-live-badge">Live</span> : null}
      </summary>
      <div className="thinking-panel-body">
        <pre className="thinking-content">{trimmed}</pre>
      </div>
    </details>
  );
}

function ImageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
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

export function MessageRenderer({
  message,
  humanName,
}: {
  message: ChatMessage;
  humanName?: string | null;
}) {
  const isUser = message.role === "user";
  const author = isUser ? humanName?.trim() || "You" : message.providerName || "Ember";
  const initials = author.slice(0, 2).toUpperCase();
  const roleLabel =
    !isUser && message.authorRole !== "user"
      ? `${message.authorRole.slice(0, 1).toUpperCase()}${message.authorRole.slice(1)}`
      : null;
  const modelLabel = !isUser ? message.modelId?.trim() ?? null : null;
  const imageAttachments = (message.attachments ?? []).filter(
    (attachment) => attachment.kind === "image",
  );

  return (
    <div className={`message ${isUser ? "user" : "assistant"}`}>
      <div className={`message-avatar ${isUser ? "user" : "assistant"}`}>
        {initials}
      </div>
      <div className="message-content">
        <div className="message-header">
          <span className="message-author">{author}</span>
          {roleLabel ? <span className="message-role">{roleLabel}</span> : null}
          {modelLabel ? <span className="message-role">{modelLabel}</span> : null}
          <span className="message-meta">{formatMessageTime(message.createdAt)}</span>
        </div>
        <ThinkingPanel content={message.thinking ?? ""} />
        <div className={`message-bubble ${isUser ? "user" : "assistant"}`}>
          <ImageAttachments attachments={imageAttachments} />
          <MessageContent content={message.content} />
        </div>
      </div>
    </div>
  );
}
