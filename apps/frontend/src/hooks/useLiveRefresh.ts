import { useEffect, useRef } from "react";
import type { GatewayLiveEventKind } from "../api";
import { subscribeGatewayLiveEvents } from "../app/live-events";

type UseLiveRefreshOptions = {
  enabled?: boolean;
  eventKinds: GatewayLiveEventKind[];
  refresh: () => void;
  debounceMs?: number;
};

export function useLiveRefresh({
  enabled = true,
  eventKinds,
  refresh,
  debounceMs = 150,
}: UseLiveRefreshOptions): void {
  const refreshRef = useRef(refresh);
  const eventKindsKey = eventKinds.join("|");

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const allowedKinds = new Set(eventKinds);

    const unsubscribe = subscribeGatewayLiveEvents((event) => {
      if (!allowedKinds.has(event.kind)) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        refreshRef.current();
      }, debounceMs);
    });

    return () => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [debounceMs, enabled, eventKindsKey]);
}
