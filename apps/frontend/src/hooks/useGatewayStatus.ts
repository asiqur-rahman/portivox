import { useEffect, useState } from "react";
import { GatewayApi, type GatewayStatus } from "../api";
import { DEFAULT_GATEWAY } from "../app/constants";
import { useLiveRefresh } from "./useLiveRefresh";

export function useGatewayStatus(screen: "auth" | "app") {
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);

  useLiveRefresh({
    enabled: screen === "app",
    eventKinds: ["gateway_status_changed", "tunnels_changed"],
    refresh: () => {
      const publicApi = new GatewayApi(DEFAULT_GATEWAY, {});
      void publicApi.getReadyz().then(setGatewayStatus).catch(() => {});
    },
  });

  useEffect(() => {
    if (screen !== "app") return;

    const publicApi = new GatewayApi(DEFAULT_GATEWAY, {});
    const fetchStatus = () => void publicApi.getReadyz().then(setGatewayStatus).catch(() => {});

    fetchStatus();
    const timer = setInterval(fetchStatus, 120_000);
    return () => clearInterval(timer);
  }, [screen]);

  return gatewayStatus;
}
