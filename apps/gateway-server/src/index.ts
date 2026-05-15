import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { nanoid } from 'nanoid';
import { TunnelRegistry } from './registry.js';
import { generateSubdomain } from './subdomain.js';

const app = Fastify({ logger: true });
const registry = new TunnelRegistry();

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

app.register(async function websocketRoutes(instance) {
  instance.get('/connect', { websocket: true }, (socket) => {
    const subdomain = generateSubdomain();

    registry.register({
      id: nanoid(),
      subdomain,
      connectedAt: Date.now()
    });

    socket.send(JSON.stringify({
      type: 'tunnel_registered',
      subdomain,
      publicUrl: `https://${subdomain}.localhost`
    }));

    socket.on('message', (payload) => {
      app.log.info({ payload: payload.toString() }, 'message received');
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
