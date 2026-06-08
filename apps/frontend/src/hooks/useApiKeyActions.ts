import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ApiKeyRecord, GatewayApi } from "../api";
import type { ConfirmState } from "../app/types";

interface UseApiKeyActionsOptions {
  api: GatewayApi;
  newKeyName: string;
  newKeyScopes: string[];
  setLoading: Dispatch<SetStateAction<boolean>>;
  setApiKeys: Dispatch<SetStateAction<ApiKeyRecord[]>>;
  setCreatedKeyToken: Dispatch<SetStateAction<string | null>>;
  setNewKeyName: Dispatch<SetStateAction<string>>;
  setShowNewKey: Dispatch<SetStateAction<boolean>>;
  setConfirm: Dispatch<SetStateAction<ConfirmState | null>>;
  showToast: (message: string, type?: "default" | "green" | "red") => void;
}

export function useApiKeyActions({
  api,
  newKeyName,
  newKeyScopes,
  setLoading,
  setApiKeys,
  setCreatedKeyToken,
  setNewKeyName,
  setShowNewKey,
  setConfirm,
  showToast,
}: UseApiKeyActionsOptions) {
  const loadApiKeys = useCallback((options?: { silent?: boolean }) => {
    setLoading(true);
    api
      .listApiKeys()
      .then(setApiKeys)
      .catch((err: unknown) => {
        if (!options?.silent) {
          showToast(err instanceof Error ? err.message : "Failed to load API keys", "red");
        }
      })
      .finally(() => setLoading(false));
  }, [api, setApiKeys, setLoading, showToast]);

  const createApiKey = useCallback(() => {
    if (!newKeyName.trim()) {
      showToast("Enter a key name", "red");
      return;
    }

    setLoading(true);
    api
      .createApiKey(newKeyName.trim(), newKeyScopes.join(","))
      .then((result) => {
        if (result.apiKey?.token) {
          setCreatedKeyToken(result.apiKey.token);
        }
        setNewKeyName("");
        setShowNewKey(false);
        return api.listApiKeys();
      })
      .then(setApiKeys)
      .then(() => showToast("API key generated!", "green"))
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to create key", "red");
      })
      .finally(() => setLoading(false));
  }, [api, newKeyName, newKeyScopes, setApiKeys, setCreatedKeyToken, setLoading, setNewKeyName, setShowNewKey, showToast]);

  const requestRevokeKey = useCallback((id: string, name: string) => {
    setConfirm({
      title: "Revoke API key?",
      message: `Revoking "${name}" will immediately invalidate it. Any services or scripts using this key will lose access.`,
      confirmLabel: "Revoke key",
      danger: true,
      onConfirm: () => {
        setConfirm(null);
        setLoading(true);
        api
          .revokeApiKey(id)
          .then(() => {
            setApiKeys((previous) => previous.filter((item) => item.id !== id));
          })
          .then(() => api.listApiKeys())
          .then(setApiKeys)
          .then(() => showToast("API key revoked", "green"))
          .catch((err: unknown) => {
            showToast(err instanceof Error ? err.message : "Failed to revoke key", "red");
          })
          .finally(() => setLoading(false));
      },
    });
  }, [api, setApiKeys, setConfirm, setLoading, showToast]);

  return { loadApiKeys, createApiKey, requestRevokeKey };
}
