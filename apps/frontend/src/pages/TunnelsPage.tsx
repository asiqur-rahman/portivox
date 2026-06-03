import type { GatewayStatus, TunnelRecord } from "../api";
import { getTunnelUrl } from "../app/helpers";

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

  const onboardingSteps = [
    { label: "Install the CLI: npm install -g portivox-client", done: tunnels.length > 0 || activeCount > 0 },
    { label: "Authenticate: portivox config apiKey <YOUR_API_KEY>", done: tunnels.length > 0 || activeCount > 0 },
    { label: "Open a tunnel: portivox open <port>", done: activeCount > 0 },
  ];

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
          <div className="metric-val" style={{ fontSize: 22 }}>-</div>
          <div className="metric-sub">Metrics coming soon</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-activity" /></div>
            Avg latency
          </div>
          <div className="metric-val" style={{ fontSize: 22 }}>-</div>
          <div className="metric-sub">Metrics coming soon</div>
        </div>
      </div>

      {aiInsightVisible && (
        <div className="ai-insight">
          <div className="ai-badge"><i className="ti ti-sparkles" /></div>
          <div style={{ flex: 1 }}>
            <div className="ai-insight-label">AI insight</div>
            <div className="ai-insight-text">
              {tunnels.length === 0
                ? <>No tunnels yet. Click <strong>New tunnel</strong> to reserve a subdomain, then run <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>portivox open &lt;port&gt;</code> to connect.</>
                : offlineCount > 0
                  ? <>You have <strong>{offlineCount}</strong> tunnel{offlineCount !== 1 ? "s" : ""} whose <strong>client machine is not reachable</strong>. Bring the remote machine back online or restart the Portivox client to reactivate them.</>
                  : activeCount === 0
                    ? <>You have <strong>{tunnels.length}</strong> reserved subdomain{tunnels.length !== 1 ? "s" : ""} but <strong>no live connections</strong>. Run <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>portivox open &lt;port&gt; --subdomain &lt;name&gt;</code> to activate one.</>
                    : <>You have <strong>{activeCount}</strong> live tunnel{activeCount !== 1 ? "s" : ""}. They are connected and ready. Use the <strong>Inspect</strong> button to replay and debug HTTP requests in real time.</>}
            </div>
          </div>
          <i className="ti ti-x ai-dismiss" onClick={() => setAiInsightVisible(false)} />
        </div>
      )}

      {activeCount === 0 && (
        <div className="section">
          <div className="section-head">
            <div className="section-title"><i className="ti ti-list-check" /> Quick onboarding</div>
          </div>
          <div className="onboarding-list">
            {onboardingSteps.map((step) => (
              <div key={step.label} className={`onboarding-step ${step.done ? "done" : ""}`}>
                <i className={`ti ti-${step.done ? "circle-check" : "circle-dashed"}`} />
                <span>{step.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-topology-star-3" /> Live sessions
            <span
              style={{
                marginLeft: 8,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                fontWeight: 500,
                color: "var(--green)",
                opacity: 0.85,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--green)",
                  display: "inline-block",
                  animation: "pulse 2s infinite",
                }}
              />
              live updates
            </span>
          </div>
          <div className="section-actions">
            <button className="btn-ghost" onClick={onRefresh} disabled={loading}>
              {loading ? <><i className="ti ti-loader-2 spin" /> Refreshing</> : <><i className="ti ti-refresh" /> Refresh</>}
            </button>
            <button className="btn-primary" onClick={onNewTunnel}>
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
            <div className="empty-title">No active tunnels</div>
            <div className="empty-desc">
              Start a tunnel from the CLI with <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>portivox open &lt;port&gt;</code>, or click below to reserve a subdomain. This list updates automatically in real time.
            </div>
            <button className="btn-primary empty-cta-btn" onClick={onNewTunnel}>
              <i className="ti ti-plus" /> New tunnel
            </button>
          </div>
        ) : (
          <>
            <div className="mobile-card-list">
              {tunnels.map((tunnel) => {
                const url = getTunnelUrl(tunnel.subdomain);
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
                      {tunnel.active && !tunnel.isCliSession && (
                        <button className="btn-ghost" onClick={() => onInspect(tunnel.subdomain)}>
                          <i className="ti ti-eye" /> Inspect
                        </button>
                      )}
                      <button
                        className="btn-ghost"
                        onClick={() => window.open(url, "_blank", "noreferrer")}
                        disabled={!tunnel.active}
                        title={tunnel.active ? "Open tunnel" : (tunnel.statusMessage ?? "Tunnel is not currently reachable")}
                      >
                        <i className="ti ti-external-link" /> {tunnel.active ? "Open" : "Unavailable"}
                      </button>
                      {!tunnel.isCliSession && (
                        <button className="stop-btn" disabled={loading} onClick={() => onDeleteTunnel(tunnel.id, tunnel.subdomain)}>
                          Stop
                        </button>
                      )}
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
                  const url = getTunnelUrl(tunnel.subdomain);
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
                            <strong>{tunnel.subdomain}</strong>
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
                            <button className="icon-btn" title="Inspect HTTP traffic" onClick={() => onInspect(tunnel.subdomain)}>
                              <i className="ti ti-eye" />
                            </button>
                          )}
                          <button className="icon-btn" title="Copy URL" onClick={() => onCopy(url)}>
                            <i className="ti ti-copy" />
                          </button>
                          <button
                            className="icon-btn"
                            title={tunnel.active ? "Open in browser" : (tunnel.statusMessage ?? "Tunnel is not currently reachable")}
                            onClick={() => window.open(url, "_blank", "noreferrer")}
                            disabled={!tunnel.active}
                          >
                            <i className="ti ti-external-link" />
                          </button>
                          {!tunnel.isCliSession && (
                            <button className="stop-btn" disabled={loading} onClick={() => onDeleteTunnel(tunnel.id, tunnel.subdomain)}>
                              Stop
                            </button>
                          )}
                          {tunnel.isCliSession && tunnel.active && (
                            <span style={{ fontSize: 11, color: "var(--text-3)", padding: "0 4px", whiteSpace: "nowrap" }}>
                              Ctrl+C to stop
                            </span>
                          )}
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
