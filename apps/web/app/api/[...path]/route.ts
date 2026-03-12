import type { NextRequest } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3005";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Headers that must be stripped to avoid conflicts when proxying a streaming response.
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"];

async function proxy(request: NextRequest, path: string[]) {
  const search = request.nextUrl.search || "";
  const target = `${API_URL}/api/${path.join("/")}${search}`;
  const headers = new Headers(request.headers);

  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }

  let response: Response;
  try {
    response = await fetch(target, init);
  } catch {
    return new Response(
      JSON.stringify({ message: "EMBER runtime is not reachable. Make sure the server is running on port 3005." }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const responseHeaders = new Headers(response.headers);
  for (const header of HOP_BY_HOP) {
    responseHeaders.delete(header);
  }
  responseHeaders.set("cache-control", "no-cache, no-transform");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  return proxy(request, path);
}
