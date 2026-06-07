export type Page =
  | "tunnels"
  | "devices"
  | "usage"
  | "api"
  | "org"
  | "settings"
  | "billing"
  | "admin:overview"
  | "admin:audit"
  | "admin:gateway"
  | "admin:tcp"
  | "inspector";

export type Theme = "light" | "dark";
export type AuthTab = "login" | "register";

export interface Toast {
  id: number;
  message: string;
  type: "default" | "green" | "red";
}

export interface UserInfo {
  email: string;
  name: string;
  initials: string;
  role: string;
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}
