import { useEffect } from "react";
import type { GatewayApi } from "../api";
import { emitGatewayLiveEvent } from "../app/live-events";

type UseRealtimeGatewayEventsOptions = {
  api: GatewayApi;
  screen: "auth" | "app";
};

export function useRealtimeGatewayEvents({
  api,
  screen,
}: UseRealtimeGatewayEventsOptions): void {
  useEffect(() => {
    if (screen !== "app") {
      return;
    }

    return api.subscribeEvents((event) => {
      emitGatewayLiveEvent(event);
    });
  }, [api, screen]);
}
