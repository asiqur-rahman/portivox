import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { nanoid } from 'nanoid';
import { TunnelRegistry } from './registry.js';
import { generateSubdomain } from './subdomain.js';

const app = Fastify({ logger: true });
const registry = new TunnelRegistry();
const pendingResponses = new Map();

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
  const subdomain = request.params.subdomain;
  const session = registry.get(subdomain);

  if (!session || !session.socket) {
    reply.code(404);
    return {
      error: 'Tunnel not connected'
    };
  }

  const streamId = nanoid();

  const responsePromise = new Promise((resolve) => {
    pendingResponses.set(streamId, resolve);
  });

  session.socket.send(JSON.stringify({
    type: 'http_request',
    streamId,
    method: request.method,
    path: request.url,
    headers: request.headers
  }));

  const tunnelResponse = await responsePromise;

  reply.code(tunnelResponse.statusCode || 200);

  if (tunnelResponse.headers) {
    for (const [key, value] of Object.entries(tunnelResponse.headers)) {
      reply.header(key, value);
    }
  }

  return tunnelResponse.bodyBase64
    ? Buffer.from(tunnelResponse.bodyBase64, 'base64').toString()
    : '';
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
        const message = JSON.parse(payload.toString());

        if (message.type === 'http_response' && message.streamId) {
          const resolver = pendingResponses.get(message.streamId);

          if (resolver) {
            resolver(message);
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
