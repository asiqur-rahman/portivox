import type { Page } from "./types";

export const DEFAULT_GATEWAY = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "";
export const INSTALL_PROMPT_REMIND_MS = 3 * 24 * 60 * 60 * 1000;

export const PAGE_TITLES: Record<Page, string> = {
  tunnels: "Tunnels",
  devices: "Devices",
  ai: "AI Assistant",
  usage: "Usage & Logs",
  api: "API Keys",
  org: "Organisation",
  settings: "Settings",
  billing: "Billing",
  "admin:overview": "Admin Overview",
  "admin:audit": "Audit Log",
  "admin:gateway": "Gateway Control",
  "admin:tcp": "TCP Port Mappings",
  inspector: "Traffic Inspector",
};

export const AI_QUICK_ACTIONS = [
  { icon: "ti-plug", title: "Expose local port", desc: "Share a dev server via a secure tunnel", prompt: "How do I expose my local port 3000 to the internet?" },
  { icon: "ti-stethoscope", title: "Diagnose idle tunnel", desc: "Investigate why connections aren't arriving", prompt: "Why is my tunnel showing zero inbound connections?" },
  { icon: "ti-database", title: "Tunnel a database", desc: "Securely expose PostgreSQL, MySQL, or Redis", prompt: "How do I create a TCP tunnel for my PostgreSQL database?" },
  { icon: "ti-shield-lock", title: "Security audit", desc: "Review open tunnels for exposure risks", prompt: "Audit my current tunnels and suggest security improvements" },
  { icon: "ti-code", title: "CLI command help", desc: "Generate the exact portivox command you need", prompt: "What portivox CLI command opens a tunnel with IP protection enabled?" },
  { icon: "ti-clock-play", title: "Auto-close rules", desc: "Stop tunnels automatically after idle timeout", prompt: "How do I configure tunnels to close automatically after 1 hour of inactivity?" },
] as const;
