// Regression guard for the "delete/update looks like it worked but the UI
// stays stale until a hard reload" bug: the PWA service worker must NEVER
// cache-first any dynamic endpoint (all /api/* calls, /l/, /r/, /healthz,
// /readyz) — only the SPA shell files and the content-hashed /assets/*
// build output. This loads the real public/sw.js in a stubbed
// self/caches/fetch environment and asserts, per path, whether it intercepts
// (calls event.respondWith) or lets the request pass straight through.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const swPath = path.join(__dirname, "..", "apps", "frontend", "public", "sw.js");
const source = fs.readFileSync(swPath, "utf8");

const ORIGIN = "https://portivox.example.com";

function loadServiceWorker() {
  const listeners = {};
  const sandbox = {
    self: {
      addEventListener: (type, handler) => { listeners[type] = handler; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
      location: new URL(ORIGIN),
    },
    caches: {
      open: () => Promise.resolve({ addAll: () => Promise.resolve(), put: () => Promise.resolve(), match: () => Promise.resolve(undefined) }),
      keys: () => Promise.resolve([]),
      match: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(true),
    },
    fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
    Response,
    URL,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "sw.js" });
  return listeners;
}

function dispatchFetch(listeners, url, mode) {
  let intercepted = false;
  let respondWithPromise = null;
  const event = {
    request: { method: "GET", url, mode: mode ?? "same-origin" },
    respondWith: (promise) => { intercepted = true; respondWithPromise = Promise.resolve(promise); },
  };
  listeners.fetch(event);
  return { intercepted, respondWithPromise };
}

async function main() {
  const listeners = loadServiceWorker();
  if (typeof listeners.fetch !== "function") {
    throw new Error("sw.js did not register a fetch listener");
  }

  const origin = ORIGIN;
  const mustBypass = [
    "/api/tunnels", "/api/keys", "/api/devices", "/api/usage", "/api/audit",
    "/api/admin/tunnels", "/api/admin/users/abc", "/api/inspect/mysub",
    "/api/inspect-tcp/__tcp_port_19000__", "/api/events",
    "/l/someaccesstoken", "/r/someredirecttoken",
    "/healthz", "/readyz", "/openapi.json", "/metrics",
  ];
  const mustCacheFirst = [
    "/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/icons.svg",
    "/assets/index-AbCd1234.js", "/assets/index-AbCd1234.css",
  ];

  const failures = [];
  for (const p of mustBypass) {
    const { intercepted } = dispatchFetch(listeners, origin + p);
    if (intercepted) failures.push(`${p} was intercepted/cached by the service worker — it must always hit the network`);
  }
  for (const p of mustCacheFirst) {
    const { intercepted } = dispatchFetch(listeners, origin + p);
    if (!intercepted) failures.push(`${p} was NOT handled by the service worker's cache-first path (expected for shell/static assets)`);
  }
  // Navigations always get the network-first shell handling regardless of path.
  const nav = dispatchFetch(listeners, origin + "/some/spa/route", "navigate");
  if (!nav.intercepted) failures.push("navigation request was not intercepted for the offline SPA-shell fallback");

  if (failures.length > 0) {
    throw new Error("Service worker scope regressions:\n  - " + failures.join("\n  - "));
  }

  console.log("Service worker scope test passed");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
