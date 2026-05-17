export type GatewayConfig = {
  gatewayPort: number;
  wsPort: number;
  rootDomain: string;
  tunnelResponseTimeoutMs: number;
  wsIdleTimeoutMs: number;
  maxRequestBodyBytes: number;
  authRequired: boolean;
  authApiKeys: string;
  authApiKeyScopes: string;
  authJwtSecret: string;
};

export type ClientConfig = {
  gatewayUrl: string;
  localUrl: string;
  localTimeoutMs: number;
  maxLocalResponseBodyBytes: number;
};

export function loadGatewayConfig(): GatewayConfig;
export function loadClientConfig(): ClientConfig;
