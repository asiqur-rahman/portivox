import { useCallback, useEffect, useState } from "react";
import { GatewayApi, type DeviceRecord } from "../api";
import { timeAgo } from "../app/helpers";
import type { Toast, UserInfo } from "../app/types";
import { useLiveRefresh } from "../hooks/useLiveRefresh";

const PLATFORM_LABEL: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

export function DevicesPage({
  user,
  api,
  onCopy,
  showToast,
  onConfirm,
}: {
  user: UserInfo | null;
  api: GatewayApi;
  onCopy: (text: string) => void;
  showToast: (msg: string, type?: Toast["type"]) => void;
  onConfirm: (state: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void;
}) {
  const installCmd = "npm install -g portivox-client";
  const registerCmd = "portivox register tk_YOUR_API_KEY";
  const openCmd = "portivox open 3000";

  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback((options?: { silent?: boolean }) => {
    setLoading(true);
    api.listDevices()
      .then(setDevices)
      .catch((error: unknown) => {
        if (!options?.silent) showToast(error instanceof Error ? error.message : "Failed to load devices", "red");
      })
      .finally(() => setLoading(false));
  }, [api, showToast]);

  useEffect(() => { refresh(); }, [refresh]);
  useLiveRefresh({ eventKinds: ["devices_changed"], refresh: () => refresh({ silent: true }) });

  function requestForget(device: DeviceRecord) {
    onConfirm({
      title: device.online ? "Disconnect and forget device?" : "Forget device?",
      message: device.online
        ? `"${device.name}" is currently online. Forgetting it disconnects its live tunnels immediately and removes it from this list.`
        : `Remove "${device.name}" from your device list. It will reappear if that machine connects again.`,
      confirmLabel: device.online ? "Disconnect & forget" : "Forget device",
      danger: true,
      onConfirm: () => {
        setBusyId(device.id);
        api.removeDevice(device.id)
          .then(() => {
            setDevices((prev) => prev.filter((d) => d.id !== device.id));
            showToast(device.online ? "Device disconnected and forgotten" : "Device forgotten", "green");
          })
          .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Failed to forget device", "red"))
          .finally(() => setBusyId(null));
      },
    });
  }

  const platformLabel = (p: string | null) => (p ? PLATFORM_LABEL[p] ?? p : "Unknown");

  return (
    <div className="page">
      <div className="section" style={{ marginBottom: 16 }}>
        <div className="section-head">
          <div className="section-title"><i className="ti ti-devices" /> Registered devices ({devices.length})</div>
          <button className="btn-ghost" onClick={() => refresh()} disabled={loading}>
            <i className={`ti ti-refresh${loading ? " spin" : ""}`} /> Refresh
          </button>
        </div>

        {loading && devices.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--text-3)" }}>
            <i className="ti ti-loader-2 spin" style={{ fontSize: 20, display: "block", marginBottom: 8 }} /> Loading devices...
          </div>
        ) : devices.length === 0 ? (
          <div className="empty">
            <i className="ti ti-device-desktop-off" />
            <div className="empty-title">No devices yet</div>
            <div className="empty-desc">
              Register the client on a machine and open a tunnel — it appears here with its live status.
              Install steps are below.
            </div>
          </div>
        ) : (
          <>
            <div className="mobile-card-list">
              {devices.map((device) => (
                <article key={device.id} className="mobile-list-card">
                  <div className="mobile-list-card-head">
                    <div className="mobile-list-title">
                      <span className="mobile-list-icon"><i className="ti ti-device-desktop" /></span>
                      <div>
                        <strong>{device.name}</strong>
                        <span>{platformLabel(device.platform)}{device.clientVersion ? ` · v${device.clientVersion}` : ""}</span>
                      </div>
                    </div>
                    <span className={`mobile-status ${device.online ? "live" : "offline"}`}>{device.online ? "Online" : "Offline"}</span>
                  </div>
                  <div className="mobile-card-meta"><span>Last seen</span><strong>{device.online ? "Now" : timeAgo(device.lastSeenAt)}</strong></div>
                  <div className="mobile-card-actions">
                    <button className="btn-ghost danger" disabled={busyId === device.id} onClick={() => requestForget(device)}>
                      <i className={`ti ti-${busyId === device.id ? "loader-2 spin" : "trash"}`} /> {device.online ? "Disconnect" : "Forget"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <table className="tbl">
              <thead><tr><th>Device</th><th>Platform</th><th>Client</th><th>Status</th><th>Last seen</th><th /></tr></thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td style={{ fontWeight: 600, color: "var(--text-1)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <i className="ti ti-device-desktop" style={{ color: "var(--text-3)" }} />
                        {device.name}
                      </div>
                    </td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{platformLabel(device.platform)}</td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{device.clientVersion ? `v${device.clientVersion}` : "-"}</td>
                    <td>
                      <div className={`tunnel-status-inline ${device.online ? "live" : "offline"}`}>
                        <span className={`status-dot ${device.online ? "dot-green" : "dot-gray"}`} />
                        {device.online ? "Online" : "Offline"}
                      </div>
                    </td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{device.online ? "Now" : timeAgo(device.lastSeenAt)}</td>
                    <td>
                      <div className="row-actions">
                        <div className={`icon-btn danger${busyId === device.id ? " disabled" : ""}`} title={device.online ? "Disconnect and forget" : "Forget device"} onClick={() => { if (busyId !== device.id) requestForget(device); }}>
                          <i className={`ti ti-${busyId === device.id ? "loader-2 spin" : "trash"}`} />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-device-laptop" /> Client installation</div>
        </div>
        <div style={{ padding: "18px 22px", display: "grid", gap: 20 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.65 }}>
            Install the Portivox client on the target machine, register the API key once, then open the local port that should be exposed through the gateway.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: "var(--accent-bg)", border: "1px solid var(--border)" }}>
            <i className="ti ti-info-circle" style={{ color: "var(--accent)", marginTop: 1 }} />
            <span style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.6 }}>
              Use an API key you generate under <strong>API Keys</strong> in this account. A device (and its
              tunnels) shows up here only for the account that owns the key — a shared server key opens tunnels
              under the gateway admin identity, so they won't appear on your account.
            </span>
          </div>
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>Install package</p>
            <div className="code-block">
              <code>{installCmd}</code>
              <div className="icon-btn" style={{ color: "#b4a9ff" }} onClick={() => onCopy(installCmd)} title="Copy"><i className="ti ti-copy" /></div>
            </div>
          </div>
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>Register API key</p>
            <div className="code-block">
              <code>{registerCmd}</code>
              <div className="icon-btn" style={{ color: "#b4a9ff" }} onClick={() => onCopy(registerCmd)} title="Copy"><i className="ti ti-copy" /></div>
            </div>
          </div>
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>Start tunnel</p>
            <div className="code-block">
              <code>{openCmd}</code>
              <div className="icon-btn" style={{ color: "#b4a9ff" }} onClick={() => onCopy(openCmd)} title="Copy"><i className="ti ti-copy" /></div>
            </div>
          </div>
          {user && user.email !== "local@anonymous" && (
            <div>
              <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 4 }}>Automation and unattended use</p>
              <p style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>
                Generate a dedicated key in <strong>API Keys</strong> when you need CI pipelines, scripts, or unattended device setup.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
