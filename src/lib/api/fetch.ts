import { API_BASE_URL } from "./mode";

/**
 * Every call to the FastAPI backend goes through here so the session cookie is
 * always sent and a 401 always lands in one place (the login screen).
 *
 * An empty NEXT_PUBLIC_API_BASE_URL means same origin: the reverse proxy
 * serves the console and routes /api and /ws to the backend.
 */

export class UnauthorizedError extends Error {
  constructor() {
    super("Not authenticated");
  }
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export function wsUrl(path: string): string {
  if (API_BASE_URL) return `${API_BASE_URL.replace(/^http/, "ws")}${path}`;
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${path}`;
}

export async function apiFetch<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    let detail = `${method} ${path} failed: ${res.status}`;
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (typeof data.detail === "string") detail = data.detail;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}
