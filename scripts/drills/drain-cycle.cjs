const http = require("node:http");

function requestJson({ baseUrl, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": String(payload.length) } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (raw) {
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const baseUrl = process.env.GATEWAY_BASE_URL || "http://127.0.0.1:8080";
  const token = process.env.ADMIN_BEARER_TOKEN;
  const apiKey = process.env.ADMIN_API_KEY;

  if (!token && !apiKey) {
    throw new Error("Provide ADMIN_BEARER_TOKEN or ADMIN_API_KEY");
  }

  const authHeaders = token ? { authorization: `Bearer ${token}` } : { "x-api-key": apiKey };

  const enableDrain = await requestJson({
    baseUrl,
    path: "/api/admin/state",
    method: "POST",
    headers: authHeaders,
    body: { draining: true },
  });

  if (enableDrain.statusCode !== 200) {
    throw new Error(`Failed to enable drain: ${enableDrain.statusCode} ${JSON.stringify(enableDrain.body)}`);
  }

  const readyDuringDrain = await requestJson({
    baseUrl,
    path: "/readyz",
    method: "GET",
    headers: {},
  });

  const disableDrain = await requestJson({
    baseUrl,
    path: "/api/admin/state",
    method: "POST",
    headers: authHeaders,
    body: { draining: false, maintenanceMode: false },
  });

  if (disableDrain.statusCode !== 200) {
    throw new Error(`Failed to disable drain: ${disableDrain.statusCode} ${JSON.stringify(disableDrain.body)}`);
  }

  const readyAfter = await requestJson({
    baseUrl,
    path: "/readyz",
    method: "GET",
    headers: {},
  });

  console.log(JSON.stringify({
    enableDrain,
    readyDuringDrain,
    disableDrain,
    readyAfter,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});