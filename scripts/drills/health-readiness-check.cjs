const http = require("node:http");

function requestRaw(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "GET",
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const healthUrl = process.env.HEALTH_URL || "http://127.0.0.1:8080/healthz";
  const readyUrl = process.env.READY_URL || "http://127.0.0.1:8080/readyz";
  const metricsUrl = process.env.METRICS_URL || "http://127.0.0.1:8080/metrics";

  const health = await requestRaw(healthUrl);
  const ready = await requestRaw(readyUrl);
  const metrics = await requestRaw(metricsUrl);

  const ok = health.statusCode === 200 && (ready.statusCode === 200 || ready.statusCode === 503) && metrics.statusCode === 200;
  if (!ok) {
    throw new Error(`Health drill failed: health=${health.statusCode}, ready=${ready.statusCode}, metrics=${metrics.statusCode}`);
  }

  console.log(JSON.stringify({
    health: { statusCode: health.statusCode },
    ready: { statusCode: ready.statusCode, body: ready.body },
    metricsSample: metrics.body.split("\n").slice(0, 8),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});