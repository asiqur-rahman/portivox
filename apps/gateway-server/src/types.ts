export interface HealthResponse {
  status: string;
  service: string;
}

export interface TunnelRegistrationRequest {
  desiredSubdomain?: string;
}
