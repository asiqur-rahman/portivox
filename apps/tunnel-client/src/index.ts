import WebSocket from 'ws';

const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:8080/connect';

function connect(): void {
  const socket = new WebSocket(gatewayUrl);

  socket.on('open', () => {
    console.log('Connected to Tunnelix gateway');

    setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'heartbeat',
          timestamp: Date.now()
        }));
      }
    }, 15000);
  });

  socket.on('message', (payload) => {
    console.log('Gateway message:', payload.toString());
  });

  socket.on('close', () => {
    console.log('Disconnected from gateway. Reconnecting...');

    setTimeout(() => {
      connect();
    }, 3000);
  });

  socket.on('error', (error) => {
    console.error('Tunnel client error', error);
  });
}

connect();
