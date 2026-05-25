import { useCallback, useRef, useState } from "react";
import type { Toast } from "../app/types";

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const showToast = useCallback((message: string, type: Toast["type"] = "default") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((toast) => toast.id !== id)), 3200);
  }, []);

  return { toasts, showToast };
}
