import type { Page } from "./types";

export const DEFAULT_GATEWAY = ((import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "").trim();
export const INSTALL_PROMPT_REMIND_MS = 3 * 24 * 60 * 60 * 1000;

export const PAGE_TITLES: Record<Page, string> = {
  tunnels: "Tunnels",
  devices: "Devices",
  usage: "Usage & Logs",
  api: "API Keys",
  org: "Organisation",
  settings: "Settings",
  billing: "Billing",
  "admin:overview": "Admin Overview",
  "admin:audit": "Audit Log",
  "admin:gateway": "Gateway Control",
  "admin:tcp": "TCP Port Mappings",
  "admin:users": "Users & Subscriptions",
  inspector: "Traffic Inspector",
};
