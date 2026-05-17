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
                    properties: { status: { type: "string" }, tunnels: { type: "number" } },
                    required: ["status", "tunnels"],
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
            "200": { description: "Ready" },
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
          responses: { "200": { description: "Updated" }, "403": { description: "Forbidden" } },
        },
      },
      "/api/admin/chunk-diagnostics": {
        get: {
          summary: "Chunk diagnostics counters",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: { "200": { description: "Diagnostics snapshot" }, "403": { description: "Forbidden" } },
        },
      },
    },
  };
}

