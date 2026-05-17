const jwt = require("jsonwebtoken");

function parseApiKeys(raw) {
  if (!raw || !raw.trim()) {
    return new Set();
  }
  return new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
}

function validateApiKey(apiKeys, candidate) {
  if (!candidate) {
    return false;
  }
  return apiKeys.has(candidate.trim());
}

function signAccessToken(payload, secret, expiresIn = "1h") {
  if (!secret) {
    throw new Error("JWT secret missing");
  }
  return jwt.sign(payload, secret, { expiresIn });
}

function verifyAccessToken(token, secret) {
  if (!secret) {
    throw new Error("JWT secret missing");
  }
  return jwt.verify(token, secret);
}

function parseScopes(raw, fallback) {
  if (!raw || !raw.trim()) {
    return [...fallback];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasScope(grantedScopes, requiredScope) {
  if (!requiredScope) {
    return true;
  }
  return grantedScopes.includes("*") || grantedScopes.includes(requiredScope);
}

function readBearerToken(value) {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = normalized.slice(7).trim();
  return token || null;
}

module.exports = {
  parseApiKeys,
  validateApiKey,
  signAccessToken,
  verifyAccessToken,
  readBearerToken,
  parseScopes,
  hasScope,
};
