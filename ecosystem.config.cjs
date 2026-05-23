// PM2 ecosystem file — used by scripts/deploy.sh to manage the gateway process.
//
// First-time setup:
//   npm install -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 save           # persist across reboots
//   pm2 startup        # generate systemd/upstart hook
//
// Subsequent deploys handled automatically by:
//   bash scripts/deploy.sh

"use strict";
module.exports = {
  apps: [
    {
      name:        "portivox-gateway",
      script:      "apps/gateway-server/dist/index.js",
      cwd:         __dirname,
      instances:   1,            // bump to "max" for cluster mode across all CPUs
      exec_mode:   "fork",
      autorestart: true,
      watch:       false,
      max_memory_restart: "512M",

      // Graceful shutdown — give in-flight requests 15 s to drain
      kill_timeout:  15000,
      wait_ready:    true,       // gateway sends process.send("ready") when up
      listen_timeout: 20000,

      // Environment is read from the .env file at the project root.
      // Do NOT inline secrets here — this file is committed to git.
      env: {
        NODE_ENV: "production",
      },

      // Structured JSON logs → separate files for easy tailing / shipping
      log_date_format:  "YYYY-MM-DD HH:mm:ss Z",
      out_file:  "logs/gateway-out.log",
      error_file: "logs/gateway-err.log",
      merge_logs: true,
    },
  ],
};
