import { useCallback, useEffect, useState } from "react";
import { GatewayApi, type GatewayStatus, type TunnelRecord } from "../api";
import { timeAgo } from "../app/helpers";
import type { Toast } from "../app/types";
import { useLiveRefresh } from "../hooks/useLiveRefresh";

export function AdminGatewayPage({
  api,
  tunnels: initialTunnels,
  showToast,
  onConfirm,
}: {
  api: GatewayApi;
  tunnels: TunnelRecord[];
  showToast: (msg: string, type?: Toast["type"]) => void;
  onConfirm: (state: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void;
}) {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [chunkDiag, setChunkDiag] = useState<{
    chunkFramesReceived: number;
    chunkStreamsReassembled: number;
    chunkIncompleteTimeouts: number;
    activeChunkAssemblies?: number;
  } | null>(null);
  const [adminTunnels, setAdminTunnels] = useState<TunnelRecord[]>(initialTunnels);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback((options?: { silent?: boolean }) => {
    setLoading(true);
    Promise.all([api.getReadyz(), api.getChunkDiagnostics(), api.listAdminTunnels()])
      .then(([gatewayStatus, diagnostics, tunnels]) => {
        setStatus(gatewayStatus);
        setChunkDiag(diagnostics as typeof chunkDiag);
        setAdminTunnels(tunnels);
      })
      .catch((error: unknown) => {
        if (!options?.silent) {
          showToast(error instanceof Error ? error.message : "Load failed", "red");
        }
      })
      .finally(() => setLoading(false));
  }, [api, showToast, chunkDiag]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useLiveRefresh({
    eventKinds: ["gateway_status_changed", "tunnels_changed"],
    refresh: () => refresh({ silent: true }),
  });

  function toggleMode(field: "maintenanceMode" | "draining", value: boolean, confirmMsg: string) {
    if (value) {
      onConfirm({
        title: `Enable ${field === "maintenanceMode" ? "Maintenance Mode" : "Draining"}?`,
        message: confirmMsg,
        confirmLabel: "Confirm",
        danger: true,
        onConfirm: () => doToggle(field, value),
      });
      return;
    }
    doToggle(field, value);
  }

  function doToggle(field: "maintenanceMode" | "draining", value: boolean) {
    setToggling(true);
    api.setAdminState({ [field]: value })
      .then((gatewayStatus) => {
        setStatus(gatewayStatus);
        showToast("Gateway state updated", "green");
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Update failed", "red"))
      .finally(() => setToggling(false));
  }

  const isHealthy = status?.ready && !status?.draining && !status?.maintenanceMode;

  return (
    <div className="page-body">
      <div className="admin-hero">
        <div className="admin-hero-left">
          <div className="admin-hero-title"><i className="ti ti-server-cog" />Gateway Control<span className="admin-hero-badge">Admin</span></div>
          <div className="admin-hero-sub">Live status, tunnel management, and runtime controls</div>
        </div>
        <div className="admin-hero-right">
          <button className="btn-ghost btn-ghost-on-dark" onClick={() => refresh()} disabled={loading}>
            <i className={`ti ti-refresh${loading ? " spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="kpi-grid kpi-grid-2">
        <div className="kpi-card" style={{ borderLeft: `3px solid ${isHealthy ? "var(--green)" : "var(--red)"}` }}>
          <div className="kpi-card-head">
            <div className="kpi-icon" style={{ background: isHealthy ? "var(--green-bg)" : "var(--red-bg)", color: isHealthy ? "var(--green)" : "var(--red)" }}>
              <i className={`ti ti-${isHealthy ? "circle-check" : "alert-triangle"}`} />
            </div>
            {status && (
              <span className="status-live" style={{ color: isHealthy ? "var(--green)" : "var(--red)" }}>
                <span className={`status-pulse ${isHealthy ? "" : "red"}`} />
                {isHealthy ? "Healthy" : status.maintenanceMode ? "Maintenance" : status.draining ? "Draining" : "Degraded"}
              </span>
            )}
          </div>
          <div className="kpi-val">{status?.activeTunnels ?? "..."}</div>
          <div className="kpi-label">Active Tunnels</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-head">
            <div className="kpi-icon purple"><i className="ti ti-stack-2" /></div>
          </div>
          <div className="kpi-val" style={{ fontSize: 20, paddingTop: 4 }}>
            {chunkDiag ? `${chunkDiag.chunkFramesReceived}` : "..."}
          </div>
          <div className="kpi-label">Chunk Frames Received</div>
          <div className="kpi-delta neutral">
            {chunkDiag ? `${chunkDiag.chunkStreamsReassembled} reassembled · ${chunkDiag.chunkIncompleteTimeouts} timeouts` : ""}
          </div>
        </div>
      </div>

      <div className="section" style={{ marginBottom: 16 }}>
        <div className="section-head">
          <div className="section-title"><i className="ti ti-settings-2" /> Runtime Controls</div>
        </div>
        <div style={{ padding: "14px 18px", display: "grid", gap: 10 }}>
          <label className="toggle-row">
            <div className="toggle-row-info">
              <div className="toggle-row-title">
                {status?.maintenanceMode && <span style={{ color: "var(--red)", marginRight: 6, fontSize: 11, fontWeight: 700 }}>ACTIVE</span>}
                Maintenance Mode
              </div>
              <div className="toggle-row-desc">Rejects all new requests with HTTP 503. Use before upgrades.</div>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={status?.maintenanceMode ?? false}
                disabled={toggling || loading}
                onChange={(event) => toggleMode("maintenanceMode", event.target.checked, "This will reject all new tunnel connections and return 503 to clients. Existing sessions are preserved.")}
              />
              <span className="toggle-track" />
            </label>
          </label>

          <label className="toggle-row">
            <div className="toggle-row-info">
              <div className="toggle-row-title">
                {status?.draining && <span style={{ color: "var(--yellow)", marginRight: 6, fontSize: 11, fontWeight: 700 }}>ACTIVE</span>}
                Draining Mode
              </div>
              <div className="toggle-row-desc">Stops accepting new WebSocket clients. Allows graceful node shutdown.</div>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={status?.draining ?? false}
                disabled={toggling || loading}
                onChange={(event) => toggleMode("draining", event.target.checked, "This will stop accepting new WebSocket tunnel connections. Enable before a rolling restart or node removal.")}
              />
              <span className="toggle-track" />
            </label>
          </label>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-topology-star-3" /> Tunnel Sessions ({adminTunnels.length})</div>
        </div>
        {adminTunnels.length === 0 ? (
          <div className="empty">
            <i className="ti ti-topology-star-3" />
            <div className="empty-title">No active tunnels</div>
            <div className="empty-desc">Tunnels appear here as users connect via the CLI.</div>
          </div>
        ) : (
          <>
            <div className="mobile-card-list">
              {adminTunnels.map((tunnel) => (
                <article key={tunnel.id} className="mobile-list-card">
                  <div className="mobile-list-card-head">
                    <div className="mobile-list-title">
                      <span className="mobile-list-icon"><i className="ti ti-topology-star-3" /></span>
                      <div>
                        <strong>{tunnel.subdomain}</strong>
                        <span>{timeAgo(tunnel.createdAt)}</span>
                      </div>
                    </div>
                    <span className={`mobile-status ${tunnel.status === "offline" ? "offline" : tunnel.active ? "live" : "reserved"}`}>
                      {tunnel.status === "offline" ? "Offline" : tunnel.active ? "Live" : "Reserved"}
                    </span>
                  </div>
                  <div className={`tunnel-state-note ${tunnel.status === "offline" ? "offline" : tunnel.active ? "live" : "reserved"}`}>
                    {tunnel.statusMessage ?? (tunnel.active ? "Client connected and forwarding traffic" : "Waiting for client machine to connect")}
                  </div>
                  <button className="mobile-url-row" onClick={() => window.open(`//${tunnel.subdomain}.${window.location.hostname}`, "_blank", "noreferrer")}>
                    <span>{tunnel.subdomain}.{window.location.hostname}</span>
                    <i className="ti ti-external-link" />
                  </button>
                  <div className="mobile-card-meta">
                    <span>Tunnel ID</span>
                    <code>{tunnel.id.slice(0, 18)}{tunnel.id.length > 18 ? "..." : ""}</code>
                  </div>
                </article>
              ))}
            </div>
            <table className="tbl">
              <thead><tr><th>Subdomain</th><th>Tunnel ID</th><th>Created</th><th>Status</th></tr></thead>
              <tbody>
                {adminTunnels.map((tunnel) => (
                  <tr key={tunnel.id}>
                    <td>
                      <a href={`//${tunnel.subdomain}.${window.location.hostname}`} target="_blank" rel="noreferrer" style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--accent)" }}>
                        {tunnel.subdomain}
                      </a>
                    </td>
                    <td><code style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-3)" }}>{tunnel.id.slice(0, 16)}...</code></td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{timeAgo(tunnel.createdAt)}</td>
                    <td>
                      <div className={`tunnel-status-inline ${tunnel.status === "offline" ? "offline" : tunnel.active ? "live" : "reserved"}`}>
                        <span>{tunnel.status === "offline" ? "Offline" : tunnel.active ? "Live" : "Reserved"}</span>
                        <small>{tunnel.statusMessage ?? (tunnel.active ? "Client connected and forwarding traffic" : "Waiting for client machine to connect")}</small>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
