export type PortivoxClientConfig = {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  headers?: Record<string, string>;
};

export declare class PortivoxClient {
  constructor(config: PortivoxClientConfig);
  setApiKey(apiKey?: string): void;
  setBearerToken(token?: string): void;
  health(): Promise<unknown>;
  ready(): Promise<unknown>;
  metrics(): Promise<string>;
  openApi(): Promise<unknown>;
  listTunnels(): Promise<unknown>;
  createTunnel(subdomain: string): Promise<unknown>;
  deleteTunnel(id: string): Promise<unknown>;
  listKeys(): Promise<unknown>;
  createKey(name: string): Promise<unknown>;
  deleteKey(id: string): Promise<unknown>;
  setAdminState(patch: { maintenanceMode?: boolean; draining?: boolean }): Promise<unknown>;
  chunkDiagnostics(): Promise<unknown>;
}

