import type { NextRequest } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3005";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Headers that must be stripped to avoid conflicts when proxying a streaming response.
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"];

async function proxy(request: NextRequest, path: string[]) {
  const originValidation = validateProxyOrigin(request);
  if (!originValidation.ok) {
    return new Response(JSON.stringify({ message: originValidation.message }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const search = request.nextUrl.search || "";
  const target = `${API_URL}/api/${path.join("/")}${search}`;
  const headers = new Headers(request.headers);
  const routePath = `/api/${path.join("/")}`;

  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  const authValue = resolveRuntimeAuthHeader(routePath, request.method);
  if (authValue) {
    headers.set("authorization", authValue);
  }

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

function validateProxyOrigin(request: NextRequest): { ok: true } | { ok: false; message: string } {
  const method = request.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return { ok: true };
  }
  const origin = request.headers.get("origin");
  if (!origin) {
    return { ok: true };
  }
  // Standard same-origin check
  if (origin === request.nextUrl.origin) {
    return { ok: true };
  }
  // Match origin against the request's Host header (handles Tailscale/LAN IPs)
  const hostHeader = request.headers.get("host");
  if (hostHeader && (origin === `http://${hostHeader}` || origin === `https://${hostHeader}`)) {
    return { ok: true };
  }
  // Check explicitly configured origins
  if (proxyAllowedOrigins.has(origin)) {
    return { ok: true };
  }
  return {
    ok: false,
    message: "Origin not allowed.",
  };
}

/** Origins allowed through the Next.js proxy, built once at startup. */
const proxyAllowedOrigins: Set<string> = (() => {
  const origins = new Set<string>();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) origins.add(appUrl);
  const corsRaw = process.env.EMBER_CORS_ORIGINS ?? "";
  for (const entry of corsRaw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed) origins.add(trimmed);
  }
  return origins;
})();

function resolveRuntimeAuthHeader(path: string, method: string): string | null {
  const requiredScope = resolveScope(path, method);
  const token = getTokenForScope(requiredScope);
  return token ? `Bearer ${token}` : null;
}

function getTokenForScope(scope: "read" | "write" | "admin"): string {
  const shared = process.env.EMBER_API_TOKEN?.trim();
  switch (scope) {
    case "read":
      return process.env.EMBER_API_TOKEN_READ?.trim() || shared || "";
    case "write":
      return process.env.EMBER_API_TOKEN_WRITE?.trim() || shared || "";
    case "admin":
      return process.env.EMBER_API_TOKEN_ADMIN?.trim() || shared || "";
  }
}

function resolveScope(path: string, method: string): "read" | "write" | "admin" {
  const upperMethod = method.toUpperCase();
  if (
    path.startsWith("/api/settings")
    || path.startsWith("/api/providers")
    || path.startsWith("/api/roles")
    || path.startsWith("/api/mcp")
    || path.startsWith("/api/terminal")
    || path.startsWith("/api/checkpoints")
  ) {
    return "admin";
  }
  if (upperMethod === "GET" || upperMethod === "HEAD") {
    return "read";
  }
  return "write";
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
