import { useEffect, useState } from "react";
import { GatewayApi, type AuditItem, type GatewayStatus } from "../api";
import { DEFAULT_GATEWAY } from "../app/constants";

export function UsagePage({ api, tunnelCount }: { api: GatewayApi; tunnelCount: number }) {
  const [gwStatus, setGwStatus] = useState<GatewayStatus | null>(null);
  const [auditItems, setAuditItems] = useState<AuditItem[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(true);

  useEffect(() => {
    setLoadingStatus(true);
    const publicApi = new GatewayApi(DEFAULT_GATEWAY, {});
    const statusPromise = publicApi.getReadyz().then(setGwStatus).catch(() => {});
    const auditPromise = api.getAudit(50).then(setAuditItems).catch(() => {});
    void Promise.all([statusPromise, auditPromise]).finally(() => setLoadingStatus(false));
  }, [api]);

  const activeTunnels = gwStatus?.activeTunnels ?? tunnelCount;

  return (
    <div className="page">
      <div className="metrics metrics-3">
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-plug-connected" /></div>
            Active tunnels
          </div>
          <div className="metric-val">{loadingStatus ? "..." : activeTunnels}</div>
          <div className="metric-sub">
            {activeTunnels > 0 ? <span className="up">Up and running</span> : "None active"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-server" /></div>
            Gateway
          </div>
          <div className="metric-val" style={{ fontSize: 15, paddingTop: 5, fontWeight: 600 }}>
            {loadingStatus ? "..." : gwStatus?.ready ? "Ready" : "Unknown"}
          </div>
          <div className={`metric-sub ${gwStatus?.ready ? "up" : ""}`}>
            {gwStatus?.maintenanceMode
              ? "Maintenance mode"
              : gwStatus?.draining
                ? "Draining"
                : gwStatus?.ready
                  ? "Healthy"
                  : "Status unknown"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-list-check" /></div>
            Audit events
          </div>
          <div className="metric-val">{loadingStatus ? "..." : auditItems.length}</div>
          <div className="metric-sub">Last 50 events</div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-list-check" /> Activity log</div>
        </div>
        {loadingStatus ? (
          <div className="empty" style={{ padding: "30px 0" }}>
            <i className="ti ti-loader-2 spin" style={{ fontSize: 28, color: "var(--accent)" }} />
          </div>
        ) : auditItems.length === 0 ? (
          <div className="empty">
            <i className="ti ti-list-check" />
            <div className="empty-title">No activity yet</div>
            <div className="empty-desc">Events will appear here as you use the system.</div>
          </div>
        ) : (
          <>
            <div className="mobile-card-list">
              {auditItems.map((item, index) => (
                <article key={item.id || index} className="mobile-list-card">
                  <div className="mobile-list-card-head">
                    <div className="mobile-list-title">
                      <span className="mobile-list-icon"><i className="ti ti-list-check" /></span>
                      <div>
                        <strong>{item.action.replace(/_/g, " ")}</strong>
                        <span>{new Date(item.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                    <span className="mobile-status">{item.resource}</span>
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
              ))}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>User</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {auditItems.map((item, index) => (
                  <tr key={item.id || index}>
                    <td><span className="chip chip-purple" style={{ fontSize: 10 }}>{item.action}</span></td>
                    <td style={{ color: "var(--text-2)", fontSize: 12 }}>
                      {item.resource}
                      {item.resourceId ? <span style={{ color: "var(--text-3)", marginLeft: 4 }}>/ {item.resourceId.slice(0, 8)}</span> : null}
                    </td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>
                      {item.userId ? `${item.userId.slice(0, 8)}...` : "-"}
                    </td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{new Date(item.createdAt).toLocaleString()}</td>
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
