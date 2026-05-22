# Portivox Security Summary

This is a customer-facing overview of how Portivox protects tunnel access and traffic.

## What Portivox Secures

- Tunnel creation is protected by **API key or JWT authentication**.
- Access can be scoped with permissions for safer team usage.
- Gateway APIs support **rate limiting** to reduce abuse risk.
- Request validation and payload limits help block malformed traffic.
- Audit events provide traceability for key actions.

## Supported Tunnel Types

- **HTTP Tunnel**: expose web applications by subdomain.
- **TCP Tunnel**: expose raw TCP services (for example SSH, RDP, database ports).

## Built-In Security Controls

- Security headers on API responses (configurable, enabled by default).
- CORS allowlist support for browser-based integrations.
- Idle timeout and connection lifecycle management.
- Optional Redis-backed registry with lease controls for multi-instance reliability.
- Idempotency support on write APIs to prevent accidental duplicate actions.

## Important Customer Guidance

For production deployments:

- Keep authentication enabled (`AUTH_REQUIRED=true`).
- Use strong secrets and rotate API keys regularly.
- Restrict exposed TCP port ranges with firewall rules.
- Prefer encrypted protocols through TCP tunnels (SSH/TLS/RDP with NLA/TLS).
- Place gateway behind HTTPS/TLS termination.
- Enable audit export for compliance and incident response workflows.

## Shared Responsibility Note

Portivox secures the tunnel platform and access controls. Customers remain responsible for:

- Security of the local services they expose,
- Host/network hardening,
- Credential and key management policies,
- Regulatory controls required by their industry.

## Need More Detail?

For technical and implementation-level details, see:

- `docs/FEATURES_SECURITY.md`
