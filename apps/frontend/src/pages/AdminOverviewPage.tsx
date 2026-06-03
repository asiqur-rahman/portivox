import { useCallback, useEffect, useState } from "react";
import { GatewayApi, type AuditItem, type GatewayStatus } from "../api";
import { actionBadge, timeAgo } from "../app/helpers";
import type { Toast } from "../app/types";
import { useLiveRefresh } from "../hooks/useLiveRefresh";

export function AdminOverviewPage({
  api,
  showToast,
}: {
  api: GatewayApi;
  showToast: (msg: string, type?: Toast["type"]) => void;
}) {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [chunkDiag, setChunkDiag] = useState<{
    chunkFramesReceived: number;
    chunkStreamsReassembled: number;
    chunkIncompleteTimeouts: number;
    activeChunkAssemblies: number;
  } | null>(null);
  const [recentAudit, setRecentAudit] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback((options?: { silent?: boolean }) => {
    setLoading(true);
    Promise.all([api.getReadyz(), api.getChunkDiagnostics(), api.getAudit(10)])
      .then(([gatewayStatus, diagnostics, audit]) => {
        setStatus(gatewayStatus);
        setChunkDiag(diagnostics as typeof chunkDiag);
        setRecentAudit(audit);
      })
      .catch((error: unknown) => {
        if (!options?.silent) {
          showToast(error instanceof Error ? error.message : "Failed to load admin data", "red");
        }
      })
      .finally(() => setLoading(false));
  }, [api, showToast, chunkDiag]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useLiveRefresh({
    eventKinds: ["gateway_status_changed", "tunnels_changed", "audit_changed"],
    refresh: () => refresh({ silent: true }),
  });

  function toggleMode(field: "maintenanceMode" | "draining", value: boolean) {
    setToggling(true);
    api.setAdminState({ [field]: value })
      .then((gatewayStatus) => {
        setStatus(gatewayStatus);
        showToast(
          field === "maintenanceMode"
            ? (value ? "Maintenance mode enabled" : "Maintenance mode disabled")
            : (value ? "Draining enabled" : "Draining disabled"),
          "green",
        );
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to update state", "red");
      })
      .finally(() => setToggling(false));
  }

  const isHealthy = status?.ready && !status?.draining && !status?.maintenanceMode;

  return (
    <div className="page-body">
      <div className="admin-hero">
        <div className="admin-hero-left">
          <div className="admin-hero-title">
            <i className="ti ti-shield-check" />
            Administration
            <span className="admin-hero-badge">Admin Panel</span>
          </div>
          <div className="admin-hero-sub">System overview with live operational updates</div>
        </div>
        <div className="admin-hero-right">
          <button className="btn-ghost btn-ghost-on-dark" onClick={() => refresh()} disabled={loading}>
            <i className={`ti ti-refresh${loading ? " spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-card-head">
            <div className="kpi-icon purple"><i className="ti ti-topology-star-3" /></div>
            {status && (
              <div className="status-live" style={{ color: status.ready ? "var(--green)" : "var(--red)" }}>
                <div className={`status-pulse ${status.ready ? "" : "red"}`} />
                {status.ready ? "Online" : "Offline"}
              </div>
            )}
          </div>
          <div className="kpi-val">{loading ? "..." : (status?.activeTunnels ?? 0)}</div>
          <div className="kpi-label">Active Tunnels</div>
          <div className="kpi-delta neutral">Connected right now</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-head">
            <div className="kpi-icon green"><i className="ti ti-server" /></div>
          </div>
          <div className="kpi-val" style={{ fontSize: 18, paddingTop: 4 }}>
            {loading ? "..." : isHealthy ? "Healthy" : status?.maintenanceMode ? "Maintenance" : status?.draining ? "Draining" : "Unknown"}
          </div>
          <div className="kpi-label">Gateway Status</div>
          <div className={`kpi-delta ${isHealthy ? "up" : "down"}`}>
            <i className={`ti ti-${isHealthy ? "circle-check" : "alert-triangle"}`} />
            {isHealthy ? "All systems operational" : "Action needed"}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-head">
            <div className="kpi-icon purple"><i className="ti ti-stack-2" /></div>
          </div>
          <div className="kpi-val">{loading ? "..." : (chunkDiag?.chunkFramesReceived ?? 0)}</div>
          <div className="kpi-label">Chunk Frames</div>
          <div className="kpi-delta neutral">
            {chunkDiag ? `${chunkDiag.chunkStreamsReassembled} reassembled` : "Loading..."}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-head">
            <div className={`kpi-icon ${(chunkDiag?.chunkIncompleteTimeouts ?? 0) > 0 ? "red" : "green"}`}>
              <i className="ti ti-clock-exclamation" />
            </div>
          </div>
          <div className="kpi-val">{loading ? "..." : (chunkDiag?.chunkIncompleteTimeouts ?? 0)}</div>
          <div className="kpi-label">Incomplete Timeouts</div>
          <div className={`kpi-delta ${(chunkDiag?.chunkIncompleteTimeouts ?? 0) > 0 ? "down" : "up"}`}>
            <i className={`ti ti-${(chunkDiag?.chunkIncompleteTimeouts ?? 0) > 0 ? "alert-triangle" : "circle-check"}`} />
            {(chunkDiag?.chunkIncompleteTimeouts ?? 0) > 0 ? "Needs attention" : "Within normal range"}
          </div>
        </div>
      </div>

      <div className="section" style={{ marginBottom: 16 }}>
        <div className="section-head">
          <div className="section-title"><i className="ti ti-adjustments" /> Gateway Controls</div>
        </div>
        <div style={{ padding: "14px 18px", display: "grid", gap: 10 }}>
          <label className="toggle-row">
            <div className="toggle-row-info">
              <div className="toggle-row-title"><i className="ti ti-tools" style={{ marginRight: 6 }} />Maintenance Mode</div>
              <div className="toggle-row-desc">
                Rejects all new tunnel connections and inbound requests with 503.
                Existing WebSocket sessions are preserved.
              </div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={status?.maintenanceMode ?? false} disabled={toggling || loading} onChange={(event) => toggleMode("maintenanceMode", event.target.checked)} />
              <span className="toggle-track" />
            </label>
          </label>

          <label className="toggle-row">
            <div className="toggle-row-info">
              <div className="toggle-row-title"><i className="ti ti-arrows-left-right" style={{ marginRight: 6 }} />Draining Mode</div>
              <div className="toggle-row-desc">
                Stops accepting new WebSocket clients. Allows in-flight requests to complete
                before a rolling restart or node removal.
              </div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={status?.draining ?? false} disabled={toggling || loading} onChange={(event) => toggleMode("draining", event.target.checked)} />
              <span className="toggle-track" />
            </label>
          </label>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-activity" /> Recent Activity</div>
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>Last 10 events</div>
        </div>
        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-3)" }}>
            <i className="ti ti-loader-2 spin" style={{ fontSize: 22, display: "block", marginBottom: 8 }} />
            Loading...
          </div>
        ) : recentAudit.length === 0 ? (
          <div className="empty">
            <i className="ti ti-clipboard-off" />
            <div className="empty-title">No audit events yet</div>
            <div className="empty-desc">Events will appear here as users interact with the system.</div>
          </div>
        ) : (
          <>
            <div className="mobile-card-list">
              {recentAudit.map((item) => {
                const badge = actionBadge(item.action);
                return (
                  <article key={item.id} className="mobile-list-card">
                    <div className="mobile-list-card-head">
                      <div className="mobile-list-title">
                        <span className="mobile-list-icon"><i className={`ti ${badge.icon}`} /></span>
                        <div>
                          <strong>{item.action.replace(/_/g, " ")}</strong>
                          <span>{timeAgo(item.createdAt)}</span>
                        </div>
                      </div>
                      <span className={`mobile-status ${badge.cls === "create" ? "live" : ""}`}>{item.resource}</span>
                    </div>
                    <div className="mobile-card-meta">
                      <span>User</span>
                      <strong>{item.userId ? item.userId.slice(0, 10) : "system"}</strong>
                    </div>
                    {item.resourceId && (
                      <div className="mobile-card-meta">
                        <span>Resource ID</span>
                        <code>{item.resourceId.slice(0, 16)}</code>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>User</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recentAudit.map((item) => {
                  const badge = actionBadge(item.action);
                  return (
                    <tr key={item.id}>
                      <td>
                        <span className={`action-badge ${badge.cls}`}>
                          <i className={`ti ${badge.icon}`} />
                          {item.action.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td style={{ color: "var(--text-2)", fontSize: 12 }}>
                        {item.resource}
                        {item.resourceId ? <><br /><code style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{item.resourceId.slice(0, 12)}...</code></> : null}
                      </td>
                      <td>
                        <span className="tunnel-user-chip">
                          <i className="ti ti-user" />
                          {item.userId ? `${item.userId.slice(0, 8)}...` : "system"}
                        </span>
                      </td>
                      <td style={{ color: "var(--text-3)", fontSize: 12 }} title={new Date(item.createdAt).toLocaleString()}>
                        {timeAgo(item.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
