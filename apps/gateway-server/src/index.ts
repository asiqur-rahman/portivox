import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { nanoid } from 'nanoid';
import { TunnelRegistry } from './registry.js';
import { generateSubdomain } from './subdomain.js';

type TunnelHttpResponse = {
  type: 'http_response';
  streamId: string;
  statusCode: number;
  headers?: Record<string, string | string[] | number | undefined>;
  bodyBase64?: string;
};

type PendingResponse = {
  resolve: (response: TunnelHttpResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024
});

const registry = new TunnelRegistry();
const pendingResponses = new Map<string, PendingResponse>();
const requestTimeoutMs = Number(process.env.TUNNEL_REQUEST_TIMEOUT_MS || 30000);

await app.register(websocket);

app.get('/health', async () => {
  return {
    status: 'ok',
    service: 'tunnelix-gateway'
  };
});

app.get('/api/tunnels', async () => {
  return registry.list();
});

app.all('/tunnel/:subdomain/*', async (request, reply) => {
  const params = request.params as { subdomain: string };
  const session = registry.get(params.subdomain);

  if (!session || !session.socket) {
    reply.code(404);
    return {
      error: 'Tunnel not connected'
    };
  }

  const streamId = nanoid();
  const forwardedPath = request.url.replace(`/tunnel/${params.subdomain}`, '') || '/';

  const responsePromise = new Promise<TunnelHttpResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingResponses.delete(streamId);
      reject(new Error('Tunnel request timed out'));
    }, requestTimeoutMs);

    pendingResponses.set(streamId, { resolve, reject, timeout });
  });

  const bodyBase64 = request.body
    ? Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body)).toString('base64')
    : undefined;

  session.socket.send(JSON.stringify({
    type: 'http_request',
    streamId,
    method: request.method,
    path: forwardedPath,
    headers: request.headers,
    bodyBase64
  }));

  try {
    const tunnelResponse = await responsePromise;

    reply.code(tunnelResponse.statusCode || 200);

    if (tunnelResponse.headers) {
      for (const [key, value] of Object.entries(tunnelResponse.headers)) {
        if (value !== undefined) {
          reply.header(key, value as string);
        }
      }
    }

    return tunnelResponse.bodyBase64
      ? Buffer.from(tunnelResponse.bodyBase64, 'base64').toString()
      : '';
  } catch (error) {
    reply.code(504);
    return {
      error: error instanceof Error ? error.message : 'Tunnel request failed'
    };
  }
});

app.register(async function websocketRoutes(instance) {
  instance.get('/connect', { websocket: true }, (socket) => {
    const subdomain = generateSubdomain();

    registry.register({
      id: nanoid(),
      subdomain,
      connectedAt: Date.now(),
      socket
    });

    socket.send(JSON.stringify({
      type: 'tunnel_registered',
      subdomain,
      publicUrl: `http://localhost:8080/tunnel/${subdomain}`
    }));

    socket.on('message', (payload) => {
      try {
        const message = JSON.parse(payload.toString()) as TunnelHttpResponse | { type: string; streamId?: string; message?: string };

        if (message.type === 'http_response' && message.streamId) {
          const pending = pendingResponses.get(message.streamId);

          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(message as TunnelHttpResponse);
            pendingResponses.delete(message.streamId);
          }
        }

        if (message.type === 'error' && message.streamId) {
          const pending = pendingResponses.get(message.streamId);

          if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(message.message || 'Tunnel client error'));
            pendingResponses.delete(message.streamId);
          }
        }
      } catch (error) {
        app.log.error(error);
      }
    });

    socket.on('close', () => {
      registry.remove(subdomain);
      app.log.info({ subdomain }, 'tunnel disconnected');
    });
  });
});

const port = Number(process.env.PORT || 8080);

app.listen({ host: '0.0.0.0', port })
  .then(() => {
    app.log.info(`Tunnelix gateway listening on ${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
