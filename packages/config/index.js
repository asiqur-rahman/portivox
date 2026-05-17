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

function loadGatewayConfig() {
  return {
    gatewayPort: parseInteger("GATEWAY_PORT", 8080),
    wsPort: parseInteger("GATEWAY_WS_PORT", 7000),
    rootDomain: parseRootDomain("ROOT_DOMAIN", "localtest.me"),
    tunnelResponseTimeoutMs: parseInteger("TUNNEL_RESPONSE_TIMEOUT_MS", 20000),
    wsIdleTimeoutMs: parseInteger("WS_IDLE_TIMEOUT_MS", 30000),
    maxRequestBodyBytes: parseInteger("MAX_REQUEST_BODY_BYTES", 1048576),
    authRequired: parseBoolean("AUTH_REQUIRED", false),
    authApiKeys: parseString("AUTH_API_KEYS", ""),
    authApiKeyScopes: parseString("AUTH_API_KEY_SCOPES", "tunnel:create,tunnel:read,tunnel:delete,key:manage"),
    authJwtSecret: parseString("AUTH_JWT_SECRET", ""),
  };
}

function loadClientConfig() {
  return {
    gatewayUrl: parseUrl("TUNNEL_GATEWAY_URL", "ws://localhost:7000/connect"),
    localUrl: parseUrl("TUNNEL_LOCAL_URL", "http://localhost:3000"),
    localTimeoutMs: parseInteger("LOCAL_REQUEST_TIMEOUT_MS", 15000),
    maxLocalResponseBodyBytes: parseInteger("MAX_LOCAL_RESPONSE_BODY_BYTES", 2097152),
  };
}

module.exports = {
  loadGatewayConfig,
  loadClientConfig,
};
