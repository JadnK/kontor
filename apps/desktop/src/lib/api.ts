export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

type Listener = () => void;

/** Dünner REST-Client. Ein Exemplar pro aktiver Verbindung. */
export class Api {
  private onUnauthorized: Listener | null = null;

  constructor(
    public baseUrl: string,
    public token: string | null,
  ) {}

  setUnauthorizedHandler(fn: Listener | null) {
    this.onUnauthorized = fn;
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { "X-Kontor-Client": "desktop" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new ApiError(0, "Server nicht erreichbar. Verbindung prüfen.", "offline");
    }
    if (!res.ok) {
      let msg = `Fehler ${res.status}`;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: string; code?: string };
        if (j.error) msg = j.error;
        code = j.code;
      } catch {
        /* keine JSON-Antwort */
      }
      if (res.status === 401 && this.token && code === "unauthorized") this.onUnauthorized?.();
      throw new ApiError(res.status, msg, code);
    }
    return res;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body);
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  del<T>(path: string) {
    return this.request<T>("DELETE", path);
  }

  async download(path: string): Promise<{ blob: Blob; filename: string }> {
    const res = await this.raw("GET", path);
    const cd = res.headers.get("Content-Disposition") ?? "";
    const m = /filename="?([^";]+)"?/.exec(cd);
    return { blob: await res.blob(), filename: m?.[1] ?? "download" };
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
