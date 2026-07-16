export type TunnelStatus = "live" | "reserved" | "offline";

export type TunnelRecord = {
  id: string;
  userId?: string | null;
  subdomain: string | null;
  publicHost?: string | null;
  publicPort?: number | null;
  /** "tcp" for raw TCP tunnels (SSH/DB) reachable at host:port, "http" otherwise. */
  tunnelType?: "http" | "tcp";
  createdAt: string;
  /** True when a live WebSocket client is currently connected for this subdomain. */
  active: boolean;
  /** Richer dashboard status for user-facing tunnel state. */
  status?: TunnelStatus;
  /** Human-readable hint about the current tunnel reachability. */
  statusMessage?: string;
  /** Last time the gateway observed this tunnel live or reachable. */
  lastSeenAt?: string | null;
  /** Time the tunnel was explicitly marked disconnected/unreachable. */
  disconnectedAt?: string | null;
  /**
   * True for tunnels created via `portivox open` that have no DB record.
   * These sessions cannot be stopped from the dashboard — the user must
   * press Ctrl+C in their terminal to disconnect.
   */
  isCliSession?: boolean;
  /**
   * Stable status-page URL (e.g. https://host/r/:token). Present for most
   * sessions; may be null if the redirect entry has not yet been created.
   */
  redirectUrl?: string | null;
};

export type ApiKeyRecord = {
  id: string;
  name: string;
  createdAt: string;
  revoked: boolean;
  scopes: string[];
};

export type AuditItem = {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type AdminState = {
  draining: boolean;
  maintenanceMode: boolean;
};

export type TcpPortMapping = {
  id: string;
  name: string;
  localPort: number;
  publicPort: number;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GatewayStatus = {
  ready: boolean;
  draining: boolean;
  maintenanceMode: boolean;
  activeTunnels: number;
};

export type AdminUser = {
  id: string;
  email: string;
  subdomainEnabled: boolean;
  createdAt: string;
};

export type GatewayLiveEventKind =
  | "connected"
  | "tunnels_changed"
  | "gateway_status_changed"
  | "audit_changed"
  | "api_keys_changed"
  | "tcp_mappings_changed"
  | "users_changed"
  | "inspector_changed";

export type GatewayLiveEvent = {
  kind: GatewayLiveEventKind;
  at: string;
  userId?: string | null;
  subdomain?: string | null;
};

export type ChunkDiagnostics = {
  chunkFramesReceived: number;
  chunkStreamsReassembled: number;
  chunkIncompleteTimeouts: number;
};

export type CapturedRequestSummary = {
  id: string;
  capturedAt: number;
  durationMs: number | null;
  method: string;
  path: string;
  statusCode: number | null;
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
  error: string | null;
};

export type CapturedRequestDetail = CapturedRequestSummary & {
  requestHeaders: Record<string, string | string[] | undefined>;
  responseHeaders: Record<string, string | string[] | undefined>;
  requestBodyBase64: string;
  responseBodyBase64: string;
};

export type AuthResponse = {
  user: { id: string; email: string; role: "owner" | "admin" | "viewer" };
  accessToken: string;
  tokenType: "Bearer";
};

type GatewayAuth = {
  apiKey?: string;
  accessToken?: string;
};

export class GatewayApi {
  constructor(private readonly baseUrl: string, private readonly auth: GatewayAuth) {}

  async register(email: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
      authOverride: {},
    });
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
      authOverride: {},
    });
  }

  async listTunnels(): Promise<TunnelRecord[]> {
    const result = await this.request<{ tunnels: TunnelRecord[] }>("/api/tunnels", { method: "GET" });
    return Array.isArray(result.tunnels) ? result.tunnels : [];
  }

  async listAdminTunnels(): Promise<TunnelRecord[]> {
    const result = await this.request<{ tunnels: TunnelRecord[] }>("/api/admin/tunnels", { method: "GET" });
    return Array.isArray(result.tunnels) ? result.tunnels : [];
  }

  async createTunnel(subdomain: string): Promise<TunnelRecord> {
    const result = await this.request<{ tunnel: TunnelRecord }>("/api/tunnels", {
      method: "POST",
      body: JSON.stringify({ subdomain }),
    });
    return result.tunnel;
  }

  async deleteTunnel(id: string): Promise<void> {
    await this.request(`/api/tunnels/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    const result = await this.request<{ keys: ApiKeyRecord[] }>("/api/keys", { method: "GET" });
    return Array.isArray(result.keys) ? result.keys : [];
  }

  async createApiKey(name: string, scopes: string): Promise<{ apiKey?: { id: string; name: string; token?: string; scopes?: string[] } }> {
    return this.request("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    });
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.request("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  async getReadyz(): Promise<{ ready: boolean; draining: boolean; maintenanceMode: boolean; activeTunnels: number }> {
    return this.request("/readyz", { method: "GET" });
  }

  async setAdminState(patch: Partial<AdminState>): Promise<GatewayStatus> {
    return this.request("/api/admin/state", {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }

  async getChunkDiagnostics(): Promise<ChunkDiagnostics> {
    return this.request("/api/admin/chunk-diagnostics", { method: "GET" });
  }

  async getAudit(limit = 20): Promise<AuditItem[]> {
    const result = await this.request<{ items: AuditItem[] }>(`/api/audit?limit=${Math.max(1, Math.min(100, limit))}`, { method: "GET" });
    return Array.isArray(result.items) ? result.items : [];
  }

  async getAuditFiltered(params: {
    limit?: number;
    action?: string;
    resource?: string;
    userId?: string;
    from?: string;
    to?: string;
    cursor?: string;
  }): Promise<{ items: AuditItem[]; nextCursor?: string; count: number }> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(Math.max(1, Math.min(100, params.limit))));
    if (params.action) qs.set("action", params.action);
    if (params.resource) qs.set("resource", params.resource);
    if (params.userId) qs.set("userId", params.userId);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.cursor) qs.set("cursor", params.cursor);
    return this.request<{ items: AuditItem[]; nextCursor?: string; count: number }>(`/api/audit?${qs}`, { method: "GET" });
  }

  async listTcpPortMappings(): Promise<TcpPortMapping[]> {
    const result = await this.request<{ mappings: TcpPortMapping[] }>("/api/admin/tcp-port-mappings", { method: "GET" });
    return Array.isArray(result.mappings) ? result.mappings : [];
  }

  async createTcpPortMapping(data: { name: string; localPort: number; publicPort: number; description?: string }): Promise<TcpPortMapping> {
    const result = await this.request<{ mapping: TcpPortMapping }>("/api/admin/tcp-port-mappings", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return result.mapping;
  }

  async deleteTcpPortMapping(id: string): Promise<void> {
    await this.request(`/api/admin/tcp-port-mappings/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listUsers(): Promise<AdminUser[]> {
    const result = await this.request<{ users: AdminUser[] }>("/api/admin/users", { method: "GET" });
    return Array.isArray(result.users) ? result.users : [];
  }

  async setUserSubdomainEnabled(id: string, subdomainEnabled: boolean): Promise<AdminUser> {
    const result = await this.request<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ subdomainEnabled }),
    });
    return result.user;
  }

  async listInspectorRequests(subdomain: string): Promise<{ subdomain: string; count: number; requests: CapturedRequestSummary[] }> {
    return this.request(`/api/inspect/${encodeURIComponent(subdomain)}`, { method: "GET" });
  }

  async getInspectorRequest(subdomain: string, reqId: string): Promise<{ request: CapturedRequestDetail }> {
    return this.request(`/api/inspect/${encodeURIComponent(subdomain)}/${encodeURIComponent(reqId)}`, { method: "GET" });
  }

  async clearInspectorRequests(subdomain: string): Promise<void> {
    await this.request(`/api/inspect/${encodeURIComponent(subdomain)}`, { method: "DELETE" });
  }

  subscribeEvents(
    onEvent: (event: GatewayLiveEvent) => void,
    onError?: (error: Error) => void,
  ): () => void {
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    const controller = new AbortController();

    const connect = async (): Promise<void> => {
      const headers = this.buildHeaders(this.auth, false);
      try {
        const response = await fetch(`${this.baseUrl}/api/events`, {
          method: "GET",
          headers,
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok || !response.body) {
          throw new Error(`Live updates unavailable (${response.status})`);
        }

        reconnectAttempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) {
            throw new Error("Live update stream closed");
          }
          buffer += decoder.decode(value, { stream: true });

          let separatorIndex = buffer.indexOf("\n\n");
          while (separatorIndex >= 0) {
            const chunk = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            const dataLines = chunk
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart());

            if (dataLines.length > 0) {
              try {
                onEvent(JSON.parse(dataLines.join("\n")) as GatewayLiveEvent);
              } catch {
                // ignore malformed event frames
              }
            }
            separatorIndex = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (stopped || controller.signal.aborted) {
          return;
        }
        onError?.(error instanceof Error ? error : new Error(String(error)));
        reconnectAttempt += 1;
        const delayMs = Math.min(10_000, 1000 * (2 ** Math.min(reconnectAttempt, 3)));
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void connect();
        }, delayMs);
      }
    };

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }

  private async request<T = unknown>(path: string, init: RequestInit & { authOverride?: GatewayAuth }): Promise<T> {
    const auth = init.authOverride ?? this.auth;
    const headers = this.buildHeaders(auth, true, init.headers as Record<string, string> | undefined);

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const payload = (await response.json()) as { error?: { message?: string } };
        if (payload?.error?.message) {
          message = payload.error.message;
        }
      } catch {
        // ignore
      }
      throw new Error(message);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private buildHeaders(
    auth: GatewayAuth,
    includeJsonContentType: boolean,
    extraHeaders?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...(includeJsonContentType ? { "content-type": "application/json" } : {}),
      ...(extraHeaders ?? {}),
    };

    if (auth.apiKey) {
      headers["x-api-key"] = auth.apiKey;
    }
    if (auth.accessToken) {
      headers.authorization = `Bearer ${auth.accessToken}`;
    }

    return headers;
  }
}
