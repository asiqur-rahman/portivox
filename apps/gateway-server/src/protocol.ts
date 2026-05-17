import type { WireMessage } from "./types";

export type WireEnvelope = {
  v?: number;
  payload?: unknown;
  [key: string]: unknown;
};

export function encodeWireMessage(message: WireMessage): string {
  return JSON.stringify({ v: 2, ...message });
}

export function decodeWireMessage(raw: string): WireMessage {
  const parsed = JSON.parse(raw) as WireEnvelope;

  // Backward compatibility: legacy frames were unversioned plain message objects.
  if (parsed && typeof parsed.type === "string") {
    return parsed as WireMessage;
  }

  // Forward path support: envelope style { v, payload }.
  if (parsed && typeof parsed.v === "number" && parsed.payload && typeof parsed.payload === "object") {
    const payload = parsed.payload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return payload as WireMessage;
    }
  }

  throw new Error("Invalid wire message envelope");
}