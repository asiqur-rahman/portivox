#!/usr/bin/env node
const readline = require("node:readline");
const { spawn } = require("node:child_process");

function runNpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: npm ${args.join(" ")}`));
      }
    });
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

async function interactiveMenu() {
  // eslint-disable-next-line no-console
  console.log("\nPortivox CLI\n");
  // eslint-disable-next-line no-console
  console.log("1) Register API key");
  // eslint-disable-next-line no-console
  console.log("2) Open a local port");
  // eslint-disable-next-line no-console
  console.log("3) Start gateway");
  // eslint-disable-next-line no-console
  console.log("4) Start client (legacy mode)");
  // eslint-disable-next-line no-console
  console.log("5) Exit\n");

  const choice = await ask("Choose an option (1-5): ");
  if (choice === "1") {
    const apiKey = await ask("Enter API key: ");
    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error("API key is required.");
      process.exit(1);
    }
    const gateway = await ask("Gateway URL (optional, press Enter for default): ");
    const args = ["run", "portivox:register", "--", apiKey];
    if (gateway) args.push("--gateway", gateway);
    await runNpm(args);
    return;
  }

  if (choice === "2") {
    const port = await ask("Local port to expose (e.g. 3000): ");
    const mode = (await ask("Tunnel mode http/tcp (default http): ")).toLowerCase();
    const gateway = await ask("Gateway URL (optional): ");
    const subdomain = await ask("Subdomain (optional): ");
    const host = await ask("Host (optional, default 127.0.0.1): ");
    if (!port) {
      // eslint-disable-next-line no-console
      console.error("Port is required.");
      process.exit(1);
    }
    const args = ["run", "portivox:open", "--", port];
    if (gateway) args.push("--gateway", gateway);
    if (subdomain) args.push("--subdomain", subdomain);
    if (host) args.push("--host", host);
    if (mode === "tcp") args.push("--tcp");
    await runNpm(args);
    return;
  }

  if (choice === "3") {
    await runNpm(["run", "dev:gateway"]);
    return;
  }

  if (choice === "4") {
    await runNpm(["run", "dev:client"]);
    return;
  }

  if (choice === "5") {
    // eslint-disable-next-line no-console
    console.log("Bye.");
    return;
  }

  // eslint-disable-next-line no-console
  console.error("Invalid choice.");
  process.exit(1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    await interactiveMenu();
    return;
  }

  if (command === "register") {
    if (!rest[0]) {
      // eslint-disable-next-line no-console
      console.error("Usage: portivox register <apiKey> [--gateway <url>]");
      process.exit(1);
    }
    await runNpm(["run", "portivox:register", "--", ...rest]);
    return;
  }

  if (command === "open") {
    if (!rest[0]) {
      // eslint-disable-next-line no-console
      console.error("Usage: portivox open <port> [--gateway <url>] [--subdomain <name>] [--host <host>] [--tcp]");
      process.exit(1);
    }
    await runNpm(["run", "portivox:open", "--", ...rest]);
    return;
  }

  if (command === "gateway") {
    await runNpm(["run", "dev:gateway"]);
    return;
  }

  if (command === "client") {
    await runNpm(["run", "dev:client", "--", ...rest]);
    return;
  }

  // eslint-disable-next-line no-console
  console.error("Unknown command. Use: portivox, portivox register, portivox open, portivox gateway, portivox client");
  process.exit(1);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error.message);
  process.exit(1);
});
