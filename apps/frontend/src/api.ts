export type TunnelRecord = {
  id: string;
  subdomain: string;
  createdAt: string;
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

export type ChunkDiagnostics = {
  chunkFramesReceived: number;
  chunkStreamsReassembled: number;
  chunkIncompleteTimeouts: number;
};

export class GatewayApi {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  async listTunnels(): Promise<TunnelRecord[]> {
    const result = await this.request<{ tunnels: TunnelRecord[] }>("/api/tunnels", { method: "GET" });
    return Array.isArray(result.tunnels) ? result.tunnels : [];
  }

  async createTunnel(subdomain: string): Promise<TunnelRecord> {
    return this.request<TunnelRecord>("/api/tunnels", {
      method: "POST",
      body: JSON.stringify({ subdomain }),
    });
  }

  async deleteTunnel(id: string): Promise<void> {
    await this.request(`/api/tunnels/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    const result = await this.request<{ keys: ApiKeyRecord[] }>("/api/keys", { method: "GET" });
    return Array.isArray(result.keys) ? result.keys : [];
  }

  async createApiKey(name: string, scopes: string): Promise<{ id: string; name: string; token?: string; scopes?: string[] }> {
    return this.request("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    });
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async getReadyz(): Promise<{ ready: boolean; draining: boolean; maintenanceMode: boolean; activeTunnels: number }> {
    return this.request("/readyz", { method: "GET" });
  }

  async setAdminState(patch: Partial<AdminState>): Promise<AdminState> {
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

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        ...(init.headers ?? {}),
      },
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
}
