/**
 * Calls to our server (same origin: the session cookie goes along by itself). Requests that change
 * data carry the session's CSRF token. Errors become ApiError with the server's Italian message.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

/** called when the server says the session is over (401), wherever it happens */
let onUnauthenticated: (() => void) | null = null;
export const setUnauthenticatedHandler = (fn: (() => void) | null) => {
  onUnauthenticated = fn;
};

// relative to the page: works at any address (the build uses base "./")
const url = (path: string) => new URL(`api/${path.replace(/^\//, "")}`, document.baseURI).toString();

export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url(path), { method, headers, credentials: "same-origin", cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Il server non risponde. Controlla la connessione e riprova.");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const { error, code } = (data ?? {}) as { error?: string; code?: string };
    if (res.status === 401 && path !== "auth/login") onUnauthenticated?.();
    throw new ApiError(res.status, error ?? `Errore del server (${res.status}).`, code);
  }
  return data as T;
}

export const apiGet = <T>(path: string) => api<T>("GET", path);
export const apiPost = <T>(path: string, body: unknown = {}) => api<T>("POST", path, body);

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Errore imprevisto.");
