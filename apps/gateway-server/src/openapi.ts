export function buildOpenApiDocument(baseUrl?: string): Record<string, unknown> {
  const serverUrl = baseUrl && baseUrl.trim() ? baseUrl : "http://localhost:8080";
  return {
    openapi: "3.0.3",
    info: {
      title: "Portivox Gateway API",
      version: "0.1.0",
      description: "Management, readiness, observability, and admin APIs for Portivox gateway.",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        apiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      schemas: {
        ErrorEnvelope: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
        TcpPortMapping: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            localPort: { type: "integer", description: "Client-side port being forwarded (e.g. 22 for SSH)" },
            publicPort: { type: "integer", description: "Fixed public port exposed on the gateway domain (e.g. 9876)" },
            description: { type: "string", nullable: true },
            enabled: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    paths: {
      "/healthz": {
        get: {
          summary: "Liveness endpoint",
          responses: {
            "200": {
              description: "Gateway is alive",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      nodeId: { type: "string" },
                      registryBackend: { type: "string", enum: ["memory", "redis"] },
                      tunnels: { type: "number" },
                    },
                    required: ["status", "nodeId", "registryBackend", "tunnels"],
                  },
                },
              },
            },
          },
        },
      },
      "/readyz": {
        get: {
          summary: "Readiness endpoint",
          responses: {
            "200": {
              description: "Ready",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      nodeId: { type: "string" },
                      registryBackend: { type: "string", enum: ["memory", "redis"] },
                      ready: { type: "boolean" },
                      draining: { type: "boolean" },
                      maintenanceMode: { type: "boolean" },
                      drainComplete: { type: "boolean" },
                      canAcceptConnections: { type: "boolean" },
                      activeTunnels: { type: "number" },
                    },
                    required: ["nodeId", "registryBackend", "ready", "draining", "maintenanceMode", "drainComplete", "canAcceptConnections", "activeTunnels"],
                  },
                },
              },
            },
            "503": { description: "Not ready" },
          },
        },
      },
      "/metrics": {
        get: {
          summary: "Prometheus metrics endpoint",
          responses: {
            "200": { description: "Prometheus text format" },
          },
        },
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI document",
          responses: {
            "200": { description: "OpenAPI JSON" },
          },
        },
      },
      "/l/{token}": {
        get: {
          summary: "IP link protection — whitelist caller IP",
          description: "Visiting this link adds the caller's IP to the 24-hour TCP allowlist. The token is included in the `registered` message as `accessLink`.",
          parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "IP whitelisted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      whitelisted: { type: "boolean" },
                      ip: { type: "string" },
                      expiresAt: { type: "string", format: "date-time" },
                      message: { type: "string" },
                    },
                  },
                },
              },
            },
            "404": { description: "Invalid or expired access token" },
            "429": { description: "Rate limited" },
          },
        },
      },
      "/r/{token}": {
        get: {
          summary: "Stable redirect URL — tunnel status",
          description: "Returns current tunnel status. Stable across reconnects — suitable for bookmarks and scripts. Token is sent in `registered` as `redirectToken`/`redirectUrl`.",
          parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Tunnel status",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      connected: { type: "boolean" },
                      tunnelType: { type: "string", enum: ["http", "tcp"] },
                      subdomain: { type: "string", nullable: true },
                      publicHost: { type: "string", nullable: true },
                      publicPort: { type: "integer", nullable: true },
                      publicTcpPort: { type: "integer", nullable: true },
                      publicTcpHost: { type: "string", nullable: true },
                      accessLink: { type: "string", nullable: true },
                      lastSeenAt: { type: "string", format: "date-time" },
                      disconnectedAt: { type: "string", format: "date-time", nullable: true },
                    },
                  },
                },
              },
            },
            "404": { description: "Unknown redirect token" },
            "429": { description: "Rate limited" },
          },
        },
      },
      "/api/tunnels": {
        get: {
          summary: "List tunnels for principal",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: { "200": { description: "Tunnel list" }, "401": { description: "Unauthorized" } },
        },
        post: {
          summary: "Create tunnel",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { subdomain: { type: "string" } },
                  required: ["subdomain"],
                },
              },
            },
          },
          responses: { "201": { description: "Created" }, "403": { description: "Forbidden" } },
        },
      },
      "/api/tunnels/{id}": {
        delete: {
          summary: "Delete tunnel by id",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "Deleted" }, "404": { description: "Not found" } },
        },
      },
      "/api/keys": {
        get: {
          summary: "List API keys",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: { "200": { description: "Key list" } },
        },
        post: {
          summary: "Issue API key",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
              },
            },
          },
          responses: { "201": { description: "Key issued" } },
        },
      },
      "/api/keys/{id}": {
        delete: {
          summary: "Revoke API key",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "Revoked" }, "404": { description: "Not found" } },
        },
      },
      "/api/admin/state": {
        post: {
          summary: "Toggle maintenance/drain state",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    maintenanceMode: { type: "boolean" },
                    draining: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Updated state snapshot" }, "403": { description: "Forbidden" } },
        },
      },
      "/api/admin/chunk-diagnostics": {
        get: {
          summary: "Chunk diagnostics counters",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: { "200": { description: "Diagnostics snapshot" }, "403": { description: "Forbidden" } },
        },
      },
      "/api/admin/tcp-port-mappings": {
        get: {
          summary: "List TCP port mappings",
          description: "Returns all admin-configured mappings from client local ports to fixed public ports.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            "200": {
              description: "List of port mappings",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      mappings: {
                        type: "array",
                        items: { $ref: "#/components/schemas/TcpPortMapping" },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden — admin role + key:manage scope required" },
          },
        },
        post: {
          summary: "Create TCP port mapping",
          description: "Map a client local port (e.g. 22 for SSH) to a fixed public port (e.g. 9876). When a client exposes that local port the gateway will bind to the configured public port instead of a random ephemeral port.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "localPort", "publicPort"],
                  properties: {
                    name: { type: "string", example: "SSH" },
                    localPort: { type: "integer", minimum: 1, maximum: 65535, example: 22 },
                    publicPort: { type: "integer", minimum: 1, maximum: 65535, example: 9876 },
                    description: { type: "string", example: "Expose SSH on a memorable fixed port" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Mapping created", content: { "application/json": { schema: { type: "object", properties: { mapping: { $ref: "#/components/schemas/TcpPortMapping" } } } } } },
            "400": { description: "Invalid body" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
            "409": { description: "Conflict — localPort or publicPort already reserved" },
          },
        },
      },
      "/api/admin/tcp-port-mappings/{id}": {
        patch: {
          summary: "Update TCP port mapping",
          description: "Enable/disable a mapping or update its name and description. Disabling a mapping causes the next client for that localPort to get a random ephemeral port instead.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    name: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated mapping", content: { "application/json": { schema: { type: "object", properties: { mapping: { $ref: "#/components/schemas/TcpPortMapping" } } } } } },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
            "404": { description: "Mapping not found" },
          },
        },
        delete: {
          summary: "Delete TCP port mapping",
          description: "Permanently removes the mapping. Active tunnels using this port are not affected until they reconnect.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "Deleted" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
            "404": { description: "Mapping not found" },
          },
        },
      },
    },
  };
}
