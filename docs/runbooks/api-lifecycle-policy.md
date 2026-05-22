# Portivox API Lifecycle Policy

## Versioning
- Portivox management/admin endpoints are versioned through `x-api-version`.
- Current supported API version is controlled by `API_VERSION` (default `1`).
- Requests to `/api/*` with a different `x-api-version` are rejected with:
  - HTTP `400`
  - error code: `UNSUPPORTED_API_VERSION`

## Response Version Header
- All `/api/*` responses include `x-api-version` with the active version.
- This includes success and error responses.

## Deprecation Signaling
- Deprecation headers can be enabled globally:
  - `API_DEPRECATION_ENABLED=true`
  - optional `API_SUNSET_DATE=<HTTP-date>`
- When enabled, `/api/*` responses include:
  - `Deprecation: true`
  - `Sunset: <HTTP-date>` (only when configured)

## Compatibility Policy
- Backward-compatible changes should not require API version bump:
  - additive response fields
  - additive endpoints
- Breaking changes require:
  - new API version value
  - OpenAPI version update
  - SDK major/minor compatibility review

## Release Checklist Hooks
- Run:
  - `npm run openapi:export`
  - `npm run openapi:check-sdk-compat`
  - `npm run test:api-contract`

