import type { UserInfo } from "./types";
import { deriveInitials, deriveName } from "./helpers";

export function saveSession(token: string, user: UserInfo): void {
  try {
    localStorage.setItem("ptx-session", JSON.stringify({ token, ...user }));
  } catch {
    // ignore
  }
}

export function clearSession(): void {
  localStorage.removeItem("ptx-session");
}

export function loadSession(): { token: string; user: UserInfo } | null {
  try {
    const raw = localStorage.getItem("ptx-session");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      token?: string;
      email?: string;
      name?: string;
      initials?: string;
      role?: string;
    };
    if (!parsed.token || !parsed.email) return null;
    return {
      token: parsed.token,
      user: {
        email: parsed.email,
        name: parsed.name ?? deriveName(parsed.email),
        initials: parsed.initials ?? deriveInitials(parsed.email),
        role: parsed.role ?? "owner",
      },
    };
  } catch {
    return null;
  }
}
