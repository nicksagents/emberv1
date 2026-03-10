import test from "node:test";
import assert from "node:assert/strict";

import { streamProviderChat } from "../../../packages/connectors/src/drivers";
import type { PromptStack, Provider, ToolDefinition } from "@ember/core";

function makeProvider(): Provider {
  const now = new Date().toISOString();
  return {
    id: "provider-test",
    name: "default",
    typeId: "openai-compatible",
    status: "connected",
    config: {
      baseUrl: "https://provider.example/v1",
    },
    availableModels: ["qwen-test"],
    capabilities: {
      canChat: true,
      canListModels: true,
      requiresBrowserAuth: false,
      canUseImages: true,
      canUseTools: true,
    },
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  );
}

test("streamProviderChat executes tool calls emitted in reasoning text", async () => {
  const originalFetch = globalThis.fetch;
  const fetchBodies: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const thinkingChunks: string[] = [];
  const contentChunks: string[] = [];
  const promptStack: PromptStack = { shared: "", role: "", tools: "" };
  const tools: ToolDefinition[] = [
    {
      name: "browser",
      description: "Interact with the browser.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Browser action",
          },
        },
      },
    },
  ];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    fetchBodies.push(body);

    if (fetchBodies.length === 1) {
      return sseResponse([
        {
          choices: [
            {
              delta: {
                reasoning_content:
                  "Checking the page.\n<tool_call><function=browser><parameter=action>screenshot</parameter></function></tool_call>",
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {},
              finish_reason: "stop",
            },
          ],
        },
      ]);
    }

    return sseResponse([
      {
        choices: [
          {
            delta: {
              content: "The screenshot is visible.",
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {},
            finish_reason: "stop",
          },
        ],
      },
    ]);
  }) as typeof fetch;

  try {
    const result = await streamProviderChat(makeProvider(), {}, {
      modelId: null,
      promptStack,
      conversation: [],
      content: "Check the page and continue.",
      tools,
      onToolCall: async (name, input) => {
        toolCalls.push({ name, input });
        return "screenshot captured";
      },
    }, {
      onStatus() {
        // Not needed for this assertion.
      },
      onThinking(text) {
        thinkingChunks.push(text);
      },
      onContent(text) {
        contentChunks.push(text);
      },
    });

    assert.equal(fetchBodies.length, 2);
    assert.deepEqual(toolCalls, [{ name: "browser", input: { action: "screenshot" } }]);
    assert.equal(result.content, "The screenshot is visible.");
    assert.equal(result.thinking, "Checking the page.");
    assert.equal(thinkingChunks.join(""), "Checking the page.\n");
    assert.equal(contentChunks.join(""), "The screenshot is visible.");

    const secondMessages = fetchBodies[1].messages;
    assert.ok(Array.isArray(secondMessages));
    assert.match(String((secondMessages as Array<{ content?: unknown }>).at(-1)?.content ?? ""), /screenshot captured/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamProviderChat does not re-execute an identical structured tool call immediately", async () => {
  const originalFetch = globalThis.fetch;
  const fetchBodies: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const promptStack: PromptStack = { shared: "", role: "", tools: "" };
  const tools: ToolDefinition[] = [
    {
      name: "browser",
      description: "Interact with the browser.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Browser action",
          },
        },
      },
    },
  ];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    fetchBodies.push(body);

    if (fetchBodies.length === 1 || fetchBodies.length === 2) {
      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${fetchBodies.length}`,
                    function: {
                      name: "browser",
                      arguments: "{\"action\":\"screenshot\"}",
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
    }

    return sseResponse([
      {
        choices: [
          {
            delta: {
              content: "Final answer after reusing the previous tool result.",
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {},
            finish_reason: "stop",
          },
        ],
      },
    ]);
  }) as typeof fetch;

  try {
    const result = await streamProviderChat(makeProvider(), {}, {
      modelId: null,
      promptStack,
      conversation: [],
      content: "Use the browser, but do not repeat the same step forever.",
      tools,
      onToolCall: async (name, input) => {
        toolCalls.push({ name, input });
        return "screenshot captured";
      },
    }, {
      onStatus() {
        // Not needed for this assertion.
      },
      onThinking() {
        // Not needed for this assertion.
      },
      onContent() {
        // Not needed for this assertion.
      },
    });

    assert.equal(fetchBodies.length, 3);
    assert.deepEqual(toolCalls, [{ name: "browser", input: { action: "screenshot" } }]);
    assert.equal(result.content, "Final answer after reusing the previous tool result.");

    const secondMessages = fetchBodies[2].messages;
    assert.ok(Array.isArray(secondMessages));
    assert.match(
      JSON.stringify((secondMessages as Array<unknown>).at(-1)),
      /Do not repeat the same tool call immediately\./,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
