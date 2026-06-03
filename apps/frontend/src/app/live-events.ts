import type { GatewayLiveEvent } from "../api";

type GatewayLiveEventListener = (event: GatewayLiveEvent) => void;

const listeners = new Set<GatewayLiveEventListener>();

export function emitGatewayLiveEvent(event: GatewayLiveEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeGatewayLiveEvents(listener: GatewayLiveEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
