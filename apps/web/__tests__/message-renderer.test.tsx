import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ToolCall } from "@ember/core/client";
import { MessageContent, StreamingContent, ToolCallsPanel } from "../components/message-renderer";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

test("MessageContent renders markdown formatting and links", () => {
  const html = render(
    <MessageContent content={"**bold** *italic* `code` [docs](https://example.com)"} />,
  );

  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test("ToolCallsPanel shows status indicators for running and failed calls", () => {
  const calls: ToolCall[] = [
    {
      id: "tool_1",
      name: "search_files",
      arguments: { query: "router" },
      status: "running",
      startedAt: "2026-03-17T10:00:00.000Z",
    },
    {
      id: "tool_2",
      name: "read_file",
      arguments: { path: "src/app.ts" },
      result: "Error: file not found",
      status: "error",
      startedAt: "2026-03-17T10:00:01.000Z",
      endedAt: "2026-03-17T10:00:02.000Z",
    },
  ];

  const html = render(<ToolCallsPanel tools={calls} live={false} />);

  assert.match(html, /2 calls/);
  assert.match(html, /running/);
  assert.match(html, /failed/);
});

test("StreamingContent handles partial markdown without crashing", () => {
  const html = render(
    <StreamingContent content={"## Draft\n```ts\nconst x = 1;"} />,
  );

  assert.match(html, /Draft/);
  assert.match(html, /const x = 1/);
});

test("MessageContent renders very long content safely", () => {
  const content = `Start ${"lorem ipsum ".repeat(20_000)} End`;
  const html = render(<MessageContent content={content} />);

  assert.ok(html.length > 0);
  assert.match(html, /Start/);
  assert.match(html, /End/);
});
