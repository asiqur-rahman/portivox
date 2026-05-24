import { INSTALL_PROMPT_REMIND_MS } from "./constants";
import type { Page } from "./types";

export function isAdminPage(page: Page): boolean {
  return page.startsWith("admin:");
}

export function hasAdminRole(role?: string): boolean {
  return role === "admin" || role === "owner";
}

export function isStandaloneMode(): boolean {
  const mediaStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
  const iosStandalone =
    "standalone" in window.navigator &&
    Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
  return mediaStandalone || iosStandalone;
}

export function shouldSuppressInstallPrompt(): boolean {
  try {
    const raw = localStorage.getItem("ptx-install-dismissed-at");
    if (!raw) return false;
    const dismissedAt = Number(raw);
    if (!Number.isFinite(dismissedAt)) return false;
    return Date.now() - dismissedAt < INSTALL_PROMPT_REMIND_MS;
  } catch {
    return false;
  }
}

export function deriveInitials(email: string): string {
  const name = email.split("@")[0].replace(/[^a-zA-Z\s]/g, " ").trim();
  const parts = name.split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.substring(0, 2).toUpperCase();
}

export function deriveName(email: string): string {
  return email
    .split("@")[0]
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

export function getTunnelUrl(subdomain: string): string {
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return `${proto}//${subdomain}.${host}`;
}

export function getWsGatewayUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/connect`;
}

export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return "-";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function actionBadge(action: string): { cls: string; icon: string } {
  if (action.includes("created") || action.includes("registered")) return { cls: "create", icon: "ti-plus" };
  if (action.includes("deleted") || action.includes("revoked")) return { cls: "delete", icon: "ti-trash" };
  if (action.includes("login") || action.includes("auth") || action.includes("password")) return { cls: "auth", icon: "ti-lock" };
  if (action.includes("admin") || action.includes("state") || action.includes("maintenance") || action.includes("drain")) return { cls: "admin", icon: "ti-shield" };
  return { cls: "other", icon: "ti-activity" };
}
