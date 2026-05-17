export function parseApiKeys(raw: string | undefined): Set<string>;
export function validateApiKey(apiKeys: Set<string>, candidate: string | undefined): boolean;
export function signAccessToken(payload: object, secret: string, expiresIn?: string): string;
export function verifyAccessToken(token: string, secret: string): unknown;
export function readBearerToken(value: string | undefined): string | null;
export function parseScopes(raw: string | undefined, fallback: string[]): string[];
export function hasScope(grantedScopes: string[], requiredScope: string): boolean;
