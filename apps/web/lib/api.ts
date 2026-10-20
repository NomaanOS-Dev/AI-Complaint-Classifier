const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
let csrfToken: string | undefined;

type ApiResponse<T> = { data: T; response: Response };

async function loadCsrfToken() {
  const response = await fetch(`${apiBase}/auth/csrf`, { credentials: "include" });
  const payload = await response.json() as { csrfToken?: string };
  if (!response.ok || !payload.csrfToken) throw new Error("Could not start a secure session. Please try again.");
  csrfToken = payload.csrfToken;
  return csrfToken;
}

export async function apiRequest<T>(pathname: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    headers.set("x-csrf-token", csrfToken ?? await loadCsrfToken());
  }
  const response = await fetch(`${apiBase}${pathname}`, { ...options, method, headers, credentials: "include" });
  const data = response.status === 204 ? {} as T : await response.json() as T;
  const token = (data as { csrfToken?: string }).csrfToken;
  if (token) csrfToken = token;
  return { data, response };
}

export function apiErrorMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  return fallback;
}
