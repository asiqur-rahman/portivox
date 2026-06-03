function parseInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer env ${name}=${raw}`);
  }

  return parsed;
}

function parseNonNegativeInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer env ${name}=${raw}`);
  }

  return parsed;
}

function parseString(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return raw;
}

function parseUrl(name, fallback) {
  const value = parseString(name, fallback);
  try {
    new URL(value);
  } catch {
    throw new Error(`Invalid URL env ${name}=${value}`);
  }
  return value;
}

function parseRootDomain(name, fallback) {
  const value = parseString(name, fallback).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(value) || value.startsWith(".") || value.endsWith(".")) {
    throw new Error(`Invalid root domain env ${name}=${value}`);
  }
  return value;
}

function parseBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(`Invalid boolean env ${name}=${raw}`);
}

function parseEnum(name, fallback, allowedValues) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (!allowedValues.includes(value)) {
    throw new Error(`Invalid enum env ${name}=${raw}. Allowed: ${allowedValues.join(",")}`);
  }
  return value;
}

function loadGatewayConfig() {
  const config = {
    gatewayPort: parseInteger("GATEWAY_PORT", 8080),
    wsPort: parseInteger("GATEWAY_WS_PORT", 7000),
    rootDomain: parseRootDomain("ROOT_DOMAIN", "portivox.braintechsolution.com"),
    tunnelResponseTimeoutMs: parseInteger("TUNNEL_RESPONSE_TIMEOUT_MS", 20000),
    wsIdleTimeoutMs: parseInteger("WS_IDLE_TIMEOUT_MS", 30000),
    maxRequestBodyBytes: parseInteger("MAX_REQUEST_BODY_BYTES", 1048576),
    authRequired: parseBoolean("AUTH_REQUIRED", false),
    authApiKeys: parseString("AUTH_API_KEYS", ""),
    authApiKeyScopes: parseString("AUTH_API_KEY_SCOPES", "tunnel:create,tunnel:read,tunnel:delete,key:manage"),
    authJwtSecret: parseString("AUTH_JWT_SECRET", ""),
    registryBackend: parseEnum("REGISTRY_BACKEND", "memory", ["memory", "redis"]),
    redisUrl: parseString("REDIS_URL", ""),
    redisKeyPrefix: parseString("REDIS_KEY_PREFIX", "portivox:registry"),
    registryLeaseTtlMs: parseInteger("REGISTRY_LEASE_TTL_MS", 30000),
    nodeId: parseString("GATEWAY_NODE_ID", ""),
    maxConcurrentStreamsPerTunnel: parseInteger("MAX_CONCURRENT_STREAMS_PER_TUNNEL", 200),
    streamIdleTimeoutMs: parseInteger("STREAM_IDLE_TIMEOUT_MS", 15000),
    maintenanceMode: parseBoolean("MAINTENANCE_MODE", false),
    startupGraceMs: parseNonNegativeInteger("STARTUP_GRACE_MS", 0),
    auditExportJsonlPath: parseString("AUDIT_EXPORT_JSONL_PATH", ""),
    auditExportWebhookUrl: parseString("AUDIT_EXPORT_WEBHOOK_URL", ""),
    auditExportWebhookTimeoutMs: parseInteger("AUDIT_EXPORT_WEBHOOK_TIMEOUT_MS", 3000),
    auditExportWebhookSecret: parseString("AUDIT_EXPORT_WEBHOOK_SECRET", ""),
    auditExportWebhookMaxRetries: parseNonNegativeInteger("AUDIT_EXPORT_WEBHOOK_MAX_RETRIES", 3),
    auditExportWebhookRetryBaseMs: parseInteger("AUDIT_EXPORT_WEBHOOK_RETRY_BASE_MS", 250),
    auditExportDeadLetterJsonlPath: parseString("AUDIT_EXPORT_DEAD_LETTER_JSONL_PATH", ""),
    apiVersion: parseString("API_VERSION", "1"),
    apiDeprecationEnabled: parseBoolean("API_DEPRECATION_ENABLED", false),
    apiSunsetDate: parseString("API_SUNSET_DATE", ""),
    apiRateLimitReadPerMin: parseInteger("API_RATE_LIMIT_READ_PER_MIN", 600),
    apiRateLimitWritePerMin: parseInteger("API_RATE_LIMIT_WRITE_PER_MIN", 300),
    apiRateLimitAdminPerMin: parseInteger("API_RATE_LIMIT_ADMIN_PER_MIN", 120),
    ingressRateLimitPerMin: parseInteger("INGRESS_RATE_LIMIT_PER_MIN", 1200),
    corsAllowedOrigins: parseString("CORS_ALLOWED_ORIGINS", ""),
    corsAllowCredentials: parseBoolean("CORS_ALLOW_CREDENTIALS", false),
    securityHeadersEnabled: parseBoolean("SECURITY_HEADERS_ENABLED", true),
    idempotencyEnabled: parseBoolean("IDEMPOTENCY_ENABLED", true),
    idempotencyTtlMs: parseInteger("IDEMPOTENCY_TTL_MS", 300000),
    tcpTunnelEnabled: parseBoolean("TCP_TUNNEL_ENABLED", true),
    tcpTunnelBindHost: parseString("TCP_TUNNEL_BIND_HOST", "0.0.0.0"),
    tcpPublicHost: parseString("TCP_PUBLIC_HOST", ""),
    tcpPublicPortStart: parseInteger("TCP_PUBLIC_PORT_START", 19000),
    tcpPublicPortEnd: parseInteger("TCP_PUBLIC_PORT_END", 19999),
    // IP link protection — TCP ports are dark by default until IP is whitelisted
    ipProtectionDefault: parseBoolean("IP_PROTECTION_DEFAULT", true),
    // Per-IP new-connection rate limit for TCP tunnels (per minute). Defends
    // against port scanners hitting fixed public ports.
    tcpConnectionRateLimit: parseInteger("TCP_CONNECTION_RATE_LIMIT", 10),
    // Base URL used in access links and redirect URLs sent to clients. Set to
    // your public-facing URL, e.g. https://portivox.example.com
    gatewayPublicBaseUrl: parseString("GATEWAY_PUBLIC_BASE_URL", ""),
  };

  if (config.authRequired && !config.authJwtSecret) {
    throw new Error(
      "AUTH_JWT_SECRET must be set when AUTH_REQUIRED=true. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  return config;
}

function loadClientConfig() {
  return {
    gatewayUrl: parseUrl("TUNNEL_GATEWAY_URL", "wss://portivox.braintechsolution.com/connect"),
    localUrl: parseUrl("TUNNEL_LOCAL_URL", "http://localhost:3000"),
    localTimeoutMs: parseInteger("LOCAL_REQUEST_TIMEOUT_MS", 15000),
    maxLocalResponseBodyBytes: parseInteger("MAX_LOCAL_RESPONSE_BODY_BYTES", 2097152),
    responseChunkBytes: parseNonNegativeInteger("RESPONSE_CHUNK_BYTES", 0),
    // How often the client sends a heartbeat frame (ms). Also controls the
    // liveness-check window (2× this value before reconnect is triggered).
    heartbeatIntervalMs: parseInteger("HEARTBEAT_INTERVAL_MS", 5000),
  };
}

module.exports = {
  loadGatewayConfig,
  loadClientConfig,
};

