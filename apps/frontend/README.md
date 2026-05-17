# Portivox Frontend

User-facing React + Vite console for Portivox gateway.

## Run

```bash
npm run dev:frontend
```

## Features

- Configure gateway URL
- Provide API key
- List tunnels (`GET /api/tunnels`)
- Create tunnel (`POST /api/tunnels`)
- Delete tunnel (`DELETE /api/tunnels/:id`)
- Admin state toggle (`POST /api/admin/state`)
- API key management (`GET/POST/DELETE /api/keys`)
- Chunk diagnostics (`GET /api/admin/chunk-diagnostics`)
- Audit viewer (`GET /api/audit`)
