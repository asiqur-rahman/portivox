import { useCallback, useEffect, useState } from "react";
import { GatewayApi, type GatewayStatus, type TunnelRecord, type UsageStats } from "../api";
import { getTunnelUrl } from "../app/helpers";
import { useLiveRefresh } from "../hooks/useLiveRefresh";

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function tunnelStatusLabel(tunnel: TunnelRecord): string {
  if (tunnel.status === "offline") return "Offline";
  if (tunnel.active || tunnel.status === "live") return "Live";
  return "Reserved";
}

function tunnelStatusClass(tunnel: TunnelRecord): string {
  if (tunnel.status === "offline") return "offline";
  if (tunnel.active || tunnel.status === "live") return "live";
  return "reserved";
}

function tunnelSecondaryText(tunnel: TunnelRecord): string {
  if (tunnel.status === "offline" && tunnel.lastSeenAt) {
    return `Last seen ${new Date(tunnel.lastSeenAt).toLocaleString()}`;
  }
  if (tunnel.status === "reserved") {
    return "Waiting for client machine to connect";
  }
  if (tunnel.active && tunnel.lastSeenAt) {
    return `Last heartbeat ${new Date(tunnel.lastSeenAt).toLocaleTimeString()}`;
  }
  if (tunnel.isCliSession) {
    return "Connected from CLI";
  }
  return new Date(tunnel.createdAt).toLocaleDateString();
}

export function TunnelsPage({
  api,
  tunnels,
  loading,
  gatewayStatus,
  aiInsightVisible,
  setAiInsightVisible,
  onRefresh,
  onNewTunnel,
  onDeleteTunnel,
  onCopy,
  onInspect,
}: {
  api: GatewayApi;
  tunnels: TunnelRecord[];
  loading: boolean;
  gatewayStatus: GatewayStatus | null;
  aiInsightVisible: boolean;
  setAiInsightVisible: (value: boolean) => void;
  onRefresh: () => void;
  onNewTunnel: () => void;
  onDeleteTunnel: (id: string, subdomain: string) => void;
  onCopy: (text: string) => void;
  onInspect: (subdomain: string) => void;
}) {
  const activeCount = tunnels.filter((tunnel) => tunnel.active).length;
  const offlineCount = tunnels.filter((tunnel) => tunnel.status === "offline").length;

  const [usage, setUsage] = useState<UsageStats | null>(null);
  const refreshUsage = useCallback(() => {
    api.getUsage().then(setUsage).catch(() => { /* non-fatal: leave prior value */ });
  }, [api]);
  useEffect(() => { refreshUsage(); }, [refreshUsage]);
  // Usage changes as traffic flows; refresh on tunnel activity and periodically.
  useLiveRefresh({ eventKinds: ["tunnels_changed"], refresh: refreshUsage });
  useEffect(() => {
    const timer = setInterval(refreshUsage, 15000);
    return () => clearInterval(timer);
  }, [refreshUsage]);

  return (
    <div className="page">
      <div className="metrics">
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-plug-connected" /></div>
            Active tunnels
          </div>
          <div className="metric-val">{activeCount}</div>
          <div className="metric-sub">
            {activeCount > 0
              ? <span className="up">{activeCount} connected</span>
              : offlineCount > 0
                ? `${offlineCount} unreachable, none connected`
                : tunnels.length > 0
                  ? `${tunnels.length} reserved, none connected`
                  : "None active"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-server" /></div>
            Gateway status
          </div>
          <div className="metric-val" style={{ fontSize: 15, paddingTop: 5, fontWeight: 600 }}>
            {gatewayStatus == null ? "..." : gatewayStatus.ready ? "Ready" : "Unavailable"}
          </div>
          <div className={`metric-sub ${gatewayStatus?.ready ? "up" : ""}`}>
            {gatewayStatus?.maintenanceMode
              ? "Maintenance mode"
              : gatewayStatus?.draining
                ? "Draining"
                : gatewayStatus?.ready
                  ? "All systems operational"
                  : "Status unknown"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-transfer" /></div>
            Data transferred
          </div>
          <div className="metric-val" style={{ fontSize: 22 }}>{usage ? formatBytes(usage.totalBytes) : "..."}</div>
          <div className="metric-sub">
            {usage ? `${formatBytes(usage.bytesIn)} in · ${formatBytes(usage.bytesOut)} out` : "Since gateway start"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-activity" /></div>
            Avg latency
          </div>
          <div className="metric-val" style={{ fontSize: 22 }}>
            {usage == null ? "..." : usage.requests > 0 ? `${usage.avgLatencyMs} ms` : "-"}
          </div>
          <div className="metric-sub">
            {usage && usage.requests > 0 ? `Across ${usage.requests} request${usage.requests === 1 ? "" : "s"}` : "No HTTP requests yet"}
          </div>
        </div>
      </div>

      {aiInsightVisible && tunnels.length > 0 && (
        <div className="info-banner">
          <div className="info-badge"><i className="ti ti-sparkles" /></div>
          <div style={{ flex: 1 }}>
            <div className="info-banner-label">Operational summary</div>
            <div className="info-banner-text">
              {offlineCount > 0
                ? <>You have <strong>{offlineCount}</strong> tunnel{offlineCount !== 1 ? "s" : ""} whose <strong>client machine is not reachable</strong>. Bring the remote machine back online or restart the Portivox client service to reactivate them.</>
                : activeCount === 0
                  ? <>You have <strong>{tunnels.length}</strong> reserved subdomain{tunnels.length !== 1 ? "s" : ""} but <strong>no active client connections</strong>. Start the matching Portivox client session to bring one online.</>
                  : <>You have <strong>{activeCount}</strong> live tunnel{activeCount !== 1 ? "s" : ""}. Use <strong>Inspect</strong> to review HTTP traffic and troubleshoot requests in real time.</>}
            </div>
          </div>
          <i className="ti ti-x info-dismiss" onClick={() => setAiInsightVisible(false)} />
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-topology-star-3" /> Tunnel sessions
            <span className="section-live-indicator">
              <span className="section-live-dot" />
              live updates
            </span>
          </div>
          <div className="section-actions">
            <button className="btn-ghost" onClick={onRefresh} disabled={loading}>
              {loading ? <><i className="ti ti-loader-2 spin" /> Refreshing</> : <><i className="ti ti-refresh" /> Refresh</>}
            </button>
            <button data-testid="new-tunnel-button" className="btn-primary" onClick={onNewTunnel}>
              <i className="ti ti-plus" /> New tunnel
            </button>
          </div>
        </div>

        {loading && tunnels.length === 0 ? (
          <div className="skeleton-wrap">
            <div className="skeleton-line w-40" />
            <div className="skeleton-line w-90" />
            <div className="skeleton-line w-75" />
            <div className="skeleton-line w-60" />
          </div>
        ) : tunnels.length === 0 ? (
          <div className="empty">
            <i className="ti ti-topology-star-3" />
            <div className="empty-title">No tunnels yet</div>
            <div className="empty-desc">
              Reserve a subdomain here, then start the matching client with <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>portivox open &lt;port&gt;</code>. Connected sessions will appear here automatically.
            </div>
            <button data-testid="new-tunnel-empty-button" className="btn-primary empty-cta-btn" onClick={onNewTunnel}>
              <span className="btn-icon-wrap"><i className="ti ti-plus" /></span>
              <span className="btn-label">New tunnel</span>
            </button>
          </div>
        ) : (
          <>
            <div className="mobile-card-list">
              {tunnels.map((tunnel) => {
                const url = getTunnelUrl(tunnel);
                const statusClass = tunnelStatusClass(tunnel);
                return (
                  <article key={tunnel.id} className="mobile-list-card">
                    <div className="mobile-list-card-head">
                      <div className="mobile-list-title">
                        <span className="mobile-list-icon"><i className="ti ti-topology-star-3" /></span>
                        <div>
                          <strong>{tunnel.subdomain}</strong>
                          {tunnel.isCliSession && <span className="cli-badge">CLI</span>}
                          <span>{tunnelSecondaryText(tunnel)}</span>
                        </div>
                      </div>
                      <span className={`mobile-status ${statusClass}`}>
                        {tunnelStatusLabel(tunnel)}
                      </span>
                    </div>
                    <div className={`tunnel-state-note ${statusClass}`}>
                      {tunnel.statusMessage ?? tunnelSecondaryText(tunnel)}
                    </div>
                    <button className="mobile-url-row" onClick={() => onCopy(url)}>
                      <span>{url}</span>
                      <i className="ti ti-copy" />
                    </button>
                    <div className="mobile-card-actions">
                      {tunnel.accessLink && (
                        <a className="btn-ghost" href={tunnel.accessLink} target="_blank" rel="noreferrer" title="Open to unlock the port for your network">
                          <i className="ti ti-lock-open" /> Access link
                        </a>
                      )}
                      {tunnel.active && !tunnel.isCliSession && (
                        <button className="btn-ghost" onClick={() => onInspect(tunnel.subdomain ?? "")}>
                          <i className="ti ti-eye" /> Inspect
                        </button>
                      )}
                      {tunnel.tunnelType !== "tcp" && (
                        <button
                          className="btn-ghost"
                          onClick={() => window.open(url, "_blank", "noreferrer")}
                          disabled={!tunnel.active}
                          title={tunnel.active ? "Open tunnel" : (tunnel.statusMessage ?? "Tunnel is not currently reachable")}
                        >
                          <i className="ti ti-external-link" /> {tunnel.active ? "Open" : "Unavailable"}
                        </button>
                      )}
                      <button className="stop-btn" disabled={loading} onClick={() => onDeleteTunnel(tunnel.id, tunnel.subdomain ?? url)}>
                        {tunnel.isCliSession ? "Remove" : "Stop"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>

            <table className="tbl">
              <thead>
                <tr>
                  <th>Subdomain</th>
                  <th>Public URL</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tunnels.map((tunnel) => {
                  const url = getTunnelUrl(tunnel);
                  const statusClass = tunnelStatusClass(tunnel);
                  return (
                    <tr key={tunnel.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <div
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 7,
                              background: "var(--accent-bg)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <i className="ti ti-topology-star-3" style={{ fontSize: 14, color: "var(--accent)" }} />
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <strong>{tunnel.subdomain || (tunnel.tunnelType === "tcp" ? "Port tunnel" : "-")}</strong>
                            {tunnel.isCliSession && <span className="cli-badge">CLI</span>}
                          </div>
                        </div>
                      </td>
                      <td><span className="url-pill">{url}</span></td>
                      <td style={{ color: "var(--text-3)", fontSize: 12 }}>
                        <div className="tunnel-meta-cell">
                          <span>{new Date(tunnel.createdAt).toLocaleString()}</span>
                          <small>{tunnelSecondaryText(tunnel)}</small>
                        </div>
                      </td>
                      <td>
                        <div className={`tunnel-status-inline ${statusClass}`}>
                          {tunnel.active || tunnel.status === "live"
                            ? <><span className="status-dot dot-green" />Live</>
                            : tunnel.status === "offline"
                              ? <><span className="status-dot dot-red" />Offline</>
                              : <><span className="status-dot dot-gray" />Reserved</>}
                          <small>{tunnel.statusMessage ?? tunnelSecondaryText(tunnel)}</small>
                        </div>
                      </td>
                      <td>
                        <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                          {tunnel.active && !tunnel.isCliSession && (
                            <button className="icon-btn" title="Inspect HTTP traffic" onClick={() => onInspect(tunnel.subdomain ?? "")}>
                              <i className="ti ti-eye" />
                            </button>
                          )}
                          {tunnel.accessLink && (
                            <a className="icon-btn" href={tunnel.accessLink} target="_blank" rel="noreferrer" title="Open the secret access link to unlock the port for your network">
                              <i className="ti ti-lock-open" />
                            </a>
                          )}
                          <button className="icon-btn" title={tunnel.tunnelType === "tcp" ? "Copy address" : "Copy URL"} onClick={() => onCopy(url)}>
                            <i className="ti ti-copy" />
                          </button>
                          {tunnel.tunnelType !== "tcp" && (
                            <button
                              className="icon-btn"
                              title={tunnel.active ? "Open in browser" : (tunnel.statusMessage ?? "Tunnel is not currently reachable")}
                              onClick={() => window.open(url, "_blank", "noreferrer")}
                              disabled={!tunnel.active}
                            >
                              <i className="ti ti-external-link" />
                            </button>
                          )}
                          <button className="stop-btn" disabled={loading} onClick={() => onDeleteTunnel(tunnel.id, tunnel.subdomain ?? url)}>
                            {tunnel.isCliSession ? "Remove" : "Stop"}
                          </button>
                        </div>
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
