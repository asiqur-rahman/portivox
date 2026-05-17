# MVP Protocol

Current wire format uses a versioned envelope:

```json
{
  "v": 2,
  "type": "register_tunnel"
}
```

Backward compatibility:
- Unversioned legacy frames are still accepted.
- Envelope mode with `payload` is also accepted for forward compatibility.

Transport-extension scaffolding:
- `http_request` and `http_response` may include optional `meta` for future transport tuning:
- `http_request` and `http_response` may include optional `meta` for transport tuning:
  - `meta.flags: string[]`
  - `meta.chunk: { index, total?, final? }`
  - `meta.window: { credit?, ackedBytes? }`
- Current implementation supports chunked `http_response` frames:
  - client can split response payloads and emit multiple `http_response` messages with the same `streamId`
  - gateway reassembles by `meta.chunk.index` until final/total is satisfied
  - unchunked single-frame responses remain fully supported

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
