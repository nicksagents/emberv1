const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3005";
const CLIENT_API_PREFIX = "/api";

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function clientApiPath(path: string): string {
  return `${CLIENT_API_PREFIX}${path}`;
}

export { API_URL };
