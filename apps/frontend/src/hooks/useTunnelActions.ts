import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { GatewayApi, TunnelRecord } from "../api";
import type { ConfirmState } from "../app/types";

interface UseTunnelActionsOptions {
  api: GatewayApi;
  newTunnelSubdomain: string;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setTunnels: Dispatch<SetStateAction<TunnelRecord[]>>;
  setNewTunnelSubdomain: Dispatch<SetStateAction<string>>;
  setShowNewTunnel: Dispatch<SetStateAction<boolean>>;
  setConfirm: Dispatch<SetStateAction<ConfirmState | null>>;
  showToast: (message: string, type?: "default" | "green" | "red") => void;
}

export function useTunnelActions({
  api,
  newTunnelSubdomain,
  setLoading,
  setTunnels,
  setNewTunnelSubdomain,
  setShowNewTunnel,
  setConfirm,
  showToast,
}: UseTunnelActionsOptions) {
  const refreshTunnels = useCallback((options?: { silent?: boolean }) => {
    setLoading(true);
    api
      .listTunnels()
      .then(setTunnels)
      .catch((err: unknown) => {
        if (!options?.silent) {
          showToast(err instanceof Error ? err.message : "Failed to load tunnels", "red");
        }
      })
      .finally(() => setLoading(false));
  }, [api, setLoading, setTunnels, showToast]);

  const createTunnel = useCallback(() => {
    if (newTunnelSubdomain.trim().length < 3) {
      showToast("Subdomain must be at least 3 characters", "red");
      return;
    }

    setLoading(true);
    api
      .createTunnel(newTunnelSubdomain.trim().toLowerCase())
      .then(() => {
        setNewTunnelSubdomain("");
        setShowNewTunnel(false);
        return api.listTunnels();
      })
      .then(setTunnels)
      .then(() => showToast("Tunnel created!", "green"))
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to create tunnel", "red");
      })
      .finally(() => setLoading(false));
  }, [api, newTunnelSubdomain, setLoading, setNewTunnelSubdomain, setShowNewTunnel, setTunnels, showToast]);

  const requestDeleteTunnel = useCallback((id: string, subdomain: string) => {
    setConfirm({
      title: "Stop tunnel?",
      message: `This will permanently stop "${subdomain}". Any active connections will be dropped immediately.`,
      confirmLabel: "Stop tunnel",
      danger: true,
      onConfirm: () => {
        setConfirm(null);
        setLoading(true);
        api
          .deleteTunnel(id)
          .then(() => api.listTunnels())
          .then(setTunnels)
          .then(() => showToast("Tunnel stopped", "green"))
          .catch((err: unknown) => {
            showToast(err instanceof Error ? err.message : "Failed to stop tunnel", "red");
          })
          .finally(() => setLoading(false));
      },
    });
  }, [api, setConfirm, setLoading, setTunnels, showToast]);

  return { refreshTunnels, createTunnel, requestDeleteTunnel };
}
