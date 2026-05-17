# MVP Protocol

## Client -> Gateway
- `register_tunnel`: asks for a tunnel assignment
- `http_response`: returns proxied local response
- `heartbeat`: keepalive

## Gateway -> Client
- `registered`: confirms assigned subdomain
- `http_request`: carries inbound request payload
- `error`: protocol or stream error

## Shared
- `streamId` identifies a single proxied HTTP request/response pair.