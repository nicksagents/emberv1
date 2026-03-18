const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3005";
const CLIENT_API_PREFIX = "/api";

export async function getJson<T>(path: string): Promise<T> {
  const headers = new Headers();
  const authValue = resolveRuntimeAuthHeader(path, "GET");
  if (authValue) {
    headers.set("authorization", authValue);
  }
  const response = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    headers,
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function clientApiPath(path: string): string {
  return `${CLIENT_API_PREFIX}${path}`;
}

export function clientStreamApiPath(path: string): string {
  return clientApiPath(path);
}

export { API_URL };

function resolveRuntimeAuthHeader(path: string, method: string): string | null {
  const normalizedPath = path.startsWith("/api/") ? path : `/api/${path.replace(/^\/+/, "")}`;
  const requiredScope = resolveScope(normalizedPath, method);
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
