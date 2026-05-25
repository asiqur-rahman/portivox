import type { Toast } from "../../app/types";

interface ToastStackProps {
  toasts: Toast[];
}

export function ToastStack({ toasts }: ToastStackProps) {
  return (
    <div className="toast-wrap">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast${toast.type !== "default" ? ` ${toast.type}` : ""}`}>
          <i className={`ti ti-${toast.type === "green" ? "check" : toast.type === "red" ? "alert-circle" : "info-circle"}`} />
          {toast.message}
        </div>
      ))}
    </div>
  );
}
