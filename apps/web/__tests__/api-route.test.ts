import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { GET, POST } from "../app/api/[...path]/route";

function buildContext(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

test("proxy forwards scoped auth token to backend runtime", async () => {
  const originalFetch = globalThis.fetch;
  const previousReadToken = process.env.EMBER_API_TOKEN_READ;
  process.env.EMBER_API_TOKEN_READ = "read-token-test";

  const seen = { authorization: "" };
  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Headers | undefined;
    seen.authorization = headers?.get("authorization") ?? "";
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const request = new NextRequest("http://localhost:3000/api/runtime", {
      method: "GET",
    });
    const response = await GET(request, buildContext(["runtime"]));

    assert.equal(response.status, 200);
    assert.equal(seen.authorization, "Bearer read-token-test");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousReadToken === undefined) {
      delete process.env.EMBER_API_TOKEN_READ;
    } else {
      process.env.EMBER_API_TOKEN_READ = previousReadToken;
    }
  }
});

test("proxy returns 502 with clear message when backend is unreachable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;

  try {
    const request = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      body: JSON.stringify({
        mode: "auto",
        content: "hello",
        conversation: [],
      }),
      headers: {
        "content-type": "application/json",
      },
    });
    const response = await POST(request, buildContext(["chat"]));
    const payload = (await response.json()) as { message: string };

    assert.equal(response.status, 502);
    assert.match(payload.message, /runtime is not reachable/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxy preserves streaming content headers and strips hop-by-hop headers", async () => {
  const originalFetch = globalThis.fetch;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"type\":\"status\"}\n\n"));
      controller.close();
    },
  });
  globalThis.fetch = (async () => {
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        "content-length": "123",
      },
    });
  }) as typeof fetch;

  try {
    const request = new NextRequest("http://localhost:3000/api/chat/stream", {
      method: "POST",
      body: JSON.stringify({
        mode: "auto",
        content: "hello",
        conversation: [],
      }),
      headers: {
        "content-type": "application/json",
      },
    });
    const response = await POST(request, buildContext(["chat", "stream"]));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i);
    assert.equal(response.headers.get("connection"), null);
    assert.equal(response.headers.get("transfer-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
