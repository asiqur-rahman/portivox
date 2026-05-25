import { useCallback, useEffect, useState } from "react";
import { isStandaloneMode, shouldSuppressInstallPrompt } from "../app/helpers";
import type { BeforeInstallPromptEvent } from "../app/types";

interface UseInstallPromptOptions {
  appReady: boolean;
}

export function useInstallPrompt({ appReady }: UseInstallPromptOptions) {
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState<boolean>(() => isStandaloneMode());
  const [installPromptDismissed, setInstallPromptDismissed] = useState<boolean>(() => shouldSuppressInstallPrompt());

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent);
      setInstallPromptDismissed(false);
      setIsInstalled(isStandaloneMode());
    };

    const onInstalled = () => {
      setIsInstalled(true);
      setDeferredInstallPrompt(null);
      setInstallPromptDismissed(true);
      try {
        localStorage.setItem("ptx-install-dismissed-at", String(Date.now()));
      } catch {
        // ignore
      }
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismissInstallPrompt = useCallback(() => {
    setInstallPromptDismissed(true);
    try {
      localStorage.setItem("ptx-install-dismissed-at", String(Date.now()));
    } catch {
      // ignore
    }
  }, []);

  const triggerInstallPrompt = useCallback(async () => {
    if (!deferredInstallPrompt) {
      dismissInstallPrompt();
      return;
    }

    try {
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setIsInstalled(true);
      }
    } catch {
      // ignore
    } finally {
      setDeferredInstallPrompt(null);
      dismissInstallPrompt();
    }
  }, [deferredInstallPrompt, dismissInstallPrompt]);

  return {
    canInstallDirectly: Boolean(deferredInstallPrompt),
    shouldShowInstallPrompt: appReady && !isInstalled && !installPromptDismissed,
    dismissInstallPrompt,
    triggerInstallPrompt,
  };
}
