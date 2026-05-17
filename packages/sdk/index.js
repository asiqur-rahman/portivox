class TunnelixClient {
  constructor(config) {
    if (!config || !config.baseUrl) {
      throw new Error("TunnelixClient requires baseUrl");
    }
    this.baseUrl = String(config.baseUrl).replace(/\/+$/, "");
    this.apiKey = config.apiKey || "";
    this.bearerToken = config.bearerToken || "";
    this.defaultHeaders = config.headers || {};
  }

  setApiKey(apiKey) {
    this.apiKey = apiKey || "";
  }

  setBearerToken(token) {
    this.bearerToken = token || "";
  }

  async health() {
    return this.#request("GET", "/healthz");
  }

  async ready() {
    return this.#request("GET", "/readyz");
  }

  async metrics() {
    return this.#requestRaw("GET", "/metrics");
  }

  async openApi() {
    return this.#request("GET", "/openapi.json");
  }

  async listTunnels() {
    return this.#request("GET", "/api/tunnels", { auth: true });
  }

  async createTunnel(subdomain) {
    return this.#request("POST", "/api/tunnels", {
      auth: true,
      body: { subdomain },
    });
  }

  async deleteTunnel(id) {
    return this.#request("DELETE", `/api/tunnels/${encodeURIComponent(id)}`, { auth: true });
  }

  async listKeys() {
    return this.#request("GET", "/api/keys", { auth: true });
  }

  async createKey(name) {
    return this.#request("POST", "/api/keys", {
      auth: true,
      body: { name },
    });
  }

  async deleteKey(id) {
    return this.#request("DELETE", `/api/keys/${encodeURIComponent(id)}`, { auth: true });
  }

  async setAdminState(patch) {
    return this.#request("POST", "/api/admin/state", {
      auth: true,
      body: patch,
    });
  }

  async chunkDiagnostics() {
    return this.#request("GET", "/api/admin/chunk-diagnostics", { auth: true });
  }

  async #request(method, path, options = {}) {
    const response = await this.#fetch(method, path, options);
    const text = await response.text();
    const maybeJson = text ? tryParseJson(text) : null;
    if (!response.ok) {
      const error = new Error(`Tunnelix request failed ${response.status}`);
      error.status = response.status;
      error.body = maybeJson ?? text;
      throw error;
    }
    return maybeJson;
  }

  async #requestRaw(method, path, options = {}) {
    const response = await this.#fetch(method, path, options);
    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`Tunnelix request failed ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async #fetch(method, path, options = {}) {
    const headers = {
      ...this.defaultHeaders,
      ...(options.body ? { "content-type": "application/json" } : {}),
    };

    if (options.auth) {
      if (this.apiKey) {
        headers["x-api-key"] = this.apiKey;
      }
      if (this.bearerToken) {
        headers.authorization = `Bearer ${this.bearerToken}`;
      }
    }

    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = {
  TunnelixClient,
};
