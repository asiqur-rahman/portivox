import { useEffect, useState } from "react";
import { GatewayApi, type GatewayStatus } from "../api";
import { DEFAULT_GATEWAY } from "../app/constants";

export function useGatewayStatus(screen: "auth" | "app") {
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);

  useEffect(() => {
    if (screen !== "app") return;

    const publicApi = new GatewayApi(DEFAULT_GATEWAY, {});
    const fetchStatus = () => void publicApi.getReadyz().then(setGatewayStatus).catch(() => {});

    fetchStatus();
    const timer = setInterval(fetchStatus, 30_000);
    return () => clearInterval(timer);
  }, [screen]);

  return gatewayStatus;
}
