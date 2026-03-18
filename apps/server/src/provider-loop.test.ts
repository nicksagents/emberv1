import test from "node:test";
import assert from "node:assert/strict";

import { streamProviderChat } from "../../../packages/connectors/src/drivers";
import type { ChatMessage, PromptStack, Provider, ToolDefinition } from "@ember/core";

const FINAL_ANSWER_NUDGE = "Based on the information above, please provide your final answer.";

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

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object" && "text" in item) {
        return typeof item.text === "string" ? item.text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function hasRealUserQuery(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }

  return messages.some((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user") {
      return false;
    }
    const text = extractMessageText(record.content).trim();
    if (!text) {
      return false;
    }
    if (text === FINAL_ANSWER_NUDGE) {
      return false;
    }
    if (/^<tool_response>\s*[\s\S]*<\/tool_response>$/i.test(text)) {
      return false;
    }
    return true;
  });
}

function lastUserIsRealPlainTextQuery(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user") {
      continue;
    }
    if (typeof record.content !== "string") {
      return false;
    }
    const text = record.content.trim();
    if (!text || text === FINAL_ANSWER_NUDGE) {
      return false;
    }
    if (/^<tool_response>\s*[\s\S]*<\/tool_response>$/i.test(text)) {
      return false;
    }
    return true;
  }

  return false;
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
    assert.match(JSON.stringify(secondMessages), /screenshot captured/);
    assert.equal(lastUserIsRealPlainTextQuery(secondMessages), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamProviderChat executes command-style text tool calls", async () => {
  const originalFetch = globalThis.fetch;
  const fetchBodies: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const promptStack: PromptStack = { shared: "", role: "", tools: "" };
  const tools: ToolDefinition[] = [
    {
      name: "swarm_simulate",
      description: "Run a simulation.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          scenario: { type: "string" },
          domain: { type: "string" },
          persona_count: { type: "number" },
          round_count: { type: "number" },
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
                  'I should run a swarm simulation first.\n' +
                  'swarm_simulate action=create scenario="Will Bitcoin hit $100k by the end of this year?" domain=finance persona_count=8 round_count=3',
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
              content: "Simulation launched and analyzed.",
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
      content: "What are the chances Bitcoin reaches 100k this year?",
      tools,
      onToolCall: async (name, input) => {
        toolCalls.push({ name, input });
        return "Simulation started: sim_test1234";
      },
    }, {});

    assert.equal(fetchBodies.length, 2);
    assert.equal(result.content, "Simulation launched and analyzed.");
    assert.deepEqual(toolCalls, [{
      name: "swarm_simulate",
      input: {
        action: "create",
        scenario: "Will Bitcoin hit $100k by the end of this year?",
        domain: "finance",
        persona_count: 8,
        round_count: 3,
      },
    }]);
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
      /immediate duplicate/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamProviderChat keeps the compacted history summary in the provider prompt", async () => {
  const originalFetch = globalThis.fetch;
  const fetchBodies: Array<Record<string, unknown>> = [];
  const promptStack: PromptStack = { shared: "", role: "", tools: "" };
  const now = new Date().toISOString();
  const conversation: ChatMessage[] = [
    {
      id: "summary_1",
      role: "assistant" as const,
      authorRole: "coordinator" as const,
      mode: "auto" as const,
      content: "Conversation memory summary. Earlier work covered auth migration decisions and tool history.",
      createdAt: now,
      historySummary: {
        kind: "history-summary" as const,
        sourceMessageCount: 20,
        sourceToolCallCount: 5,
        generatedAt: now,
      },
    },
    ...Array.from({ length: 14 }, (_, index): ChatMessage => {
      const isUser = index % 2 === 0;
      return {
        id: `msg_${index}`,
        role: isUser ? "user" : "assistant",
        authorRole: isUser ? "user" : "director",
        mode: "auto" as const,
        content: `Recent message ${index + 1}`,
        createdAt: now,
      };
    }),
  ];

  globalThis.fetch = (async (_input, init) => {
    fetchBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return sseResponse([
      {
        choices: [
          {
            delta: {
              content: "Provider reply.",
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
      conversation,
      content: "Continue.",
    }, {});

    assert.equal(result.content, "Provider reply.");

    const firstBody = fetchBodies[0];
    const messages = firstBody.messages as Array<{ role?: string; content?: unknown }>;
    assert.ok(Array.isArray(messages));
    assert.match(String(messages[1]?.content ?? ""), /Conversation memory summary/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamProviderChat keeps persistent memory separate from compacted chat history", async () => {
  const originalFetch = globalThis.fetch;
  const fetchBodies: Array<Record<string, unknown>> = [];
  const promptStack: PromptStack = { shared: "Shared rules.", role: "Role rules.", tools: "" };

  globalThis.fetch = (async (_input, init) => {
    fetchBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return sseResponse([
      {
        choices: [
          {
            delta: {
              content: "Provider reply.",
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
      memoryContext: {
        text: "Persistent memory:\n- User profile: Born 1997-06-16. Current age: 28.",
        totalChars: 69,
        results: [],
      },
      conversation: [],
      content: "When is my birthday?",
    }, {});

    assert.equal(result.content, "Provider reply.");

    const firstBody = fetchBodies[0];
    const messages = firstBody.messages as Array<{ role?: string; content?: unknown }>;
    assert.ok(Array.isArray(messages));
    assert.equal(messages[0]?.role, "system");
    assert.match(String(messages[0]?.content ?? ""), /Persistent memory/);
    assert.doesNotMatch(String(messages[1]?.content ?? ""), /Persistent memory/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamProviderChat keeps learned procedures in a separate prompt block", async () => {
  const originalFetch = globalThis.fetch;
  const fetchBodies: Array<Record<string, unknown>> = [];
  const promptStack: PromptStack = { shared: "Shared rules.", role: "Role rules.", tools: "" };

  globalThis.fetch = (async (_input, init) => {
    fetchBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return sseResponse([
      {
        choices: [
          {
            delta: {
              content: "Provider reply.",
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
      memoryContext: {
        text: "Persistent memory:\n- Project fact: Workspace uses pnpm.",
        totalChars: 56,
        results: [],
      },
      procedureContext: {
        text: "Learned procedures:\n- When handling TypeScript build failures, run `pnpm build` after reading tsconfig.",
        totalChars: 104,
        results: [],
      },
      conversation: [],
      content: "Fix the TypeScript build.",
    }, {});

    assert.equal(result.content, "Provider reply.");

    const firstBody = fetchBodies[0];
    const messages = firstBody.messages as Array<{ role?: string; content?: unknown }>;
    assert.ok(Array.isArray(messages));
    assert.equal(messages[0]?.role, "system");
    assert.match(String(messages[0]?.content ?? ""), /Persistent memory/);
    assert.match(String(messages[0]?.content ?? ""), /Learned procedures/);
    assert.doesNotMatch(String(messages[1]?.content ?? ""), /Learned procedures/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamProviderChat surfaces provider error details for rejected requests", async () => {
  const originalFetch = globalThis.fetch;
  const promptStack: PromptStack = { shared: "", role: "", tools: "" };

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "request (22688 tokens) exceeds the available context size (10240 tokens)",
        },
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        streamProviderChat(makeProvider(), {}, {
          modelId: null,
          promptStack,
          conversation: [],
          content: "Continue.",
        }, {}),
      /exceeds the available context size \(10240 tokens\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamProviderChat supports long tool loops beyond 30 turns", async () => {
  const originalFetch = globalThis.fetch;
  const promptStack: PromptStack = { shared: "", role: "", tools: "" };
  const tools: ToolDefinition[] = [
    {
      name: "browser",
      description: "Interact with the browser.",
      inputSchema: {
        type: "object",
        properties: {
          step: {
            type: "number",
            description: "Current step.",
          },
        },
      },
    },
  ];
  let callIndex = 0;
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];

  globalThis.fetch = (async () => {
    callIndex += 1;
    if (callIndex <= 35) {
      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${callIndex}`,
                    function: {
                      name: "browser",
                      arguments: JSON.stringify({ step: callIndex }),
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
              content: "Long tool loop completed.",
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
      content: "Keep using tools until done.",
      tools,
      onToolCall: async (name, input) => {
        toolCalls.push({ name, input });
        return `tool-result-${String(input.step ?? "")}`;
      },
    }, {});

    assert.equal(result.content, "Long tool loop completed.");
    assert.equal(toolCalls.length, 35);
    assert.equal(callIndex, 36);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamProviderChat compacts tool-loop history for small local context windows", async () => {
  const originalFetch = globalThis.fetch;
  const promptStack: PromptStack = { shared: "", role: "", tools: "" };
  const provider = makeProvider();
  provider.config.baseUrl = "http://127.0.0.1:11434/v1";
  provider.config.contextWindowTokens = "6000";
  const tools: ToolDefinition[] = [
    {
      name: "browser",
      description: "Interact with the browser.",
      inputSchema: {
        type: "object",
        properties: {
          step: {
            type: "number",
            description: "Current step.",
          },
        },
      },
    },
  ];
  const fetchBodies: Array<Record<string, unknown>> = [];
  let callIndex = 0;

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    fetchBodies.push(body);
    callIndex += 1;

    if (callIndex <= 10) {
      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${callIndex}`,
                    function: {
                      name: "browser",
                      arguments: JSON.stringify({ step: callIndex }),
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
              content: "Compaction test done.",
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
    const result = await streamProviderChat(provider, {}, {
      modelId: null,
      promptStack,
      conversation: [],
      content: "Run many tool calls with large outputs.",
      tools,
      onToolCall: async (name, input) => {
        return `${name}-${String(input.step ?? "")}: ${"x".repeat(1800)}`;
      },
    }, {});

    assert.equal(result.content, "Compaction test done.");
    const sawCompactionSummary = fetchBodies.some((body) =>
      JSON.stringify(body.messages ?? []).includes("Tool-loop memory summary (auto-compacted)."),
    );
    assert.equal(sawCompactionSummary, true);
    const compactedBodies = fetchBodies.filter((body) =>
      JSON.stringify(body.messages ?? []).includes("Tool-loop memory summary (auto-compacted)."),
    );
    assert.ok(compactedBodies.length > 0);
    for (const body of compactedBodies) {
      assert.equal(hasRealUserQuery(body.messages), true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
