import http from 'node:http';
import WebSocket from 'ws';

const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:8080/connect';
const localPort = Number(process.env.LOCAL_PORT || 3000);

function forwardRequest(message, socket) {
  const request = http.request({
    hostname: '127.0.0.1',
    port: localPort,
    path: '/',
    method: message.method,
    headers: message.headers
  }, (response) => {
    const chunks = [];

    response.on('data', (chunk) => {
      chunks.push(chunk);
    });

    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('base64');

      socket.send(JSON.stringify({
        type: 'http_response',
        streamId: message.streamId,
        statusCode: response.statusCode || 200,
        headers: response.headers,
        bodyBase64: body
      }));
    });
  });

  request.on('error', (error) => {
    socket.send(JSON.stringify({
      type: 'error',
      streamId: message.streamId,
      message: error.message
    }));
  });

  request.end();
}

function connect() {
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
    const message = JSON.parse(payload.toString());

    console.log('Gateway message:', message.type);

    if (message.type === 'http_request') {
      forwardRequest(message, socket);
    }
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
