import { useCallback, useEffect, useState } from "react";
import { GatewayApi, type AuditItem } from "../api";
import { actionBadge, timeAgo } from "../app/helpers";
import type { Toast } from "../app/types";

export function AdminAuditPage({
  api,
  showToast,
}: {
  api: GatewayApi;
  showToast: (msg: string, type?: Toast["type"]) => void;
}) {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [filterAction, setFilterAction] = useState("");
  const [filterResource, setFilterResource] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterLimit, setFilterLimit] = useState(50);

  const load = useCallback((cursor?: string, pushCursor?: string) => {
    setLoading(true);
    api.getAuditFiltered({
      limit: filterLimit,
      action: filterAction || undefined,
      resource: filterResource || undefined,
      from: filterFrom || undefined,
      to: filterTo || undefined,
      cursor,
    })
      .then((result) => {
        setItems(result.items);
        setNextCursor(result.nextCursor);
        if (pushCursor) setCursorStack((stack) => [...stack, pushCursor]);
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to load audit log", "red");
      })
      .finally(() => setLoading(false));
  }, [api, filterAction, filterResource, filterFrom, filterTo, filterLimit, showToast]);

  useEffect(() => {
    setCursorStack([]);
    setNextCursor(undefined);
    load(undefined);
  }, [load]);

  function exportCsv() {
    const header = "id,userId,action,resource,resourceId,createdAt,metadata";
    const rows = items.map((item) => [
      item.id,
      item.userId ?? "",
      item.action,
      item.resource,
      item.resourceId ?? "",
      item.createdAt,
      JSON.stringify(item.metadata ?? {}).replace(/,/g, ";"),
    ].map((value) => `"${value}"`).join(","));
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `audit-${Date.now()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page-body">
      <div className="admin-hero">
        <div className="admin-hero-left">
          <div className="admin-hero-title"><i className="ti ti-clipboard-list" />Audit Log<span className="admin-hero-badge">Admin</span></div>
          <div className="admin-hero-sub">Full event history with user, resource, and timestamp details</div>
        </div>
        <div className="admin-hero-right">
          <button className="btn-ghost btn-ghost-on-dark" onClick={exportCsv} disabled={items.length === 0}>
            <i className="ti ti-download" /> Export CSV
          </button>
        </div>
      </div>

      <div className="audit-filter-bar">
        <label>Action</label>
        <select value={filterAction} onChange={(event) => setFilterAction(event.target.value)}>
          <option value="">All actions</option>
          <option value="tunnel_created">tunnel_created</option>
          <option value="tunnel_deleted">tunnel_deleted</option>
          <option value="api_key_created">api_key_created</option>
          <option value="api_key_revoked">api_key_revoked</option>
          <option value="user_registered">user_registered</option>
          <option value="user_login">user_login</option>
          <option value="password_changed">password_changed</option>
          <option value="http_auth_failed">http_auth_failed</option>
          <option value="ws_auth_failed">ws_auth_failed</option>
        </select>

        <label>Resource</label>
        <select value={filterResource} onChange={(event) => setFilterResource(event.target.value)}>
          <option value="">All resources</option>
          <option value="tunnel">tunnel</option>
          <option value="api_key">api_key</option>
          <option value="user">user</option>
          <option value="tunnel_session">tunnel_session</option>
        </select>

        <label>From</label>
        <input className="audit-date-input" type="date" value={filterFrom} onChange={(event) => setFilterFrom(event.target.value)} />

        <label>To</label>
        <input className="audit-date-input" type="date" value={filterTo} onChange={(event) => setFilterTo(event.target.value)} />

        <label>Limit</label>
        <select value={filterLimit} onChange={(event) => setFilterLimit(Number(event.target.value))}>
          {[10, 25, 50, 100].map((count) => <option key={count} value={count}>{count}</option>)}
        </select>

        <button className="btn-ghost audit-filter-clear" onClick={() => {
          setFilterAction("");
          setFilterResource("");
          setFilterFrom("");
          setFilterTo("");
          setFilterLimit(50);
        }}>
          <i className="ti ti-x" /> Clear
        </button>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-list" /> {items.length} events</div>
          <div className="section-actions">
            <button className="btn-ghost" onClick={() => {
              setCursorStack([]);
              setNextCursor(undefined);
              load(undefined);
            }} disabled={loading}>
              <i className={`ti ti-refresh${loading ? " spin" : ""}`} />
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-3)" }}>
            <i className="ti ti-loader-2 spin" style={{ fontSize: 22, display: "block", marginBottom: 8 }} />
            Loading...
          </div>
        ) : items.length === 0 ? (
          <div className="empty">
            <i className="ti ti-clipboard-off" />
            <div className="empty-title">No events match your filters</div>
            <div className="empty-desc">Try clearing the filters to see all audit events.</div>
          </div>
        ) : (
          <>
            <div className="mobile-card-list">
              {items.map((item) => {
                const badge = actionBadge(item.action);
                const metadata = item.metadata && Object.keys(item.metadata).length > 0 ? JSON.stringify(item.metadata) : "";
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
                    {item.resourceId && (
                      <div className="mobile-card-meta">
                        <span>Resource ID</span>
                        <code>{item.resourceId.slice(0, 18)}{item.resourceId.length > 18 ? "..." : ""}</code>
                      </div>
                    )}
                    <div className="mobile-card-meta">
                      <span>User</span>
                      <strong>{item.userId ? `${item.userId.slice(0, 12)}${item.userId.length > 12 ? "..." : ""}` : "system"}</strong>
                    </div>
                    {metadata && (
                      <div className="mobile-card-meta block">
                        <span>Metadata</span>
                        <code>{metadata.slice(0, 90)}{metadata.length > 90 ? "..." : ""}</code>
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
                  <th>Resource ID</th>
                  <th>User ID</th>
                  <th>Metadata</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const badge = actionBadge(item.action);
                  return (
                    <tr key={item.id}>
                      <td>
                        <span className={`action-badge ${badge.cls}`}>
                          <i className={`ti ${badge.icon}`} />
                          {item.action.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="audit-cell-resource">{item.resource}</td>
                      <td>
                        {item.resourceId
                          ? <code className="audit-cell-code">{item.resourceId.slice(0, 16)}{item.resourceId.length > 16 ? "..." : ""}</code>
                          : <span className="audit-cell-empty">-</span>}
                      </td>
                      <td>
                        {item.userId
                          ? <span className="tunnel-user-chip"><i className="ti ti-user" />{item.userId.slice(0, 10)}{item.userId.length > 10 ? "..." : ""}</span>
                          : <span className="audit-cell-empty">system</span>}
                      </td>
                      <td className="audit-cell-metadata">
                        {item.metadata && Object.keys(item.metadata).length > 0
                          ? (() => {
                              const metadata = JSON.stringify(item.metadata);
                              return (
                                <code className="audit-cell-code audit-cell-code-wrap">
                                  {metadata.slice(0, 60)}{metadata.length > 60 ? "..." : ""}
                                </code>
                              );
                            })()
                          : <span className="audit-cell-empty">-</span>}
                      </td>
                      <td className="audit-cell-time" title={new Date(item.createdAt).toLocaleString()}>
                        {timeAgo(item.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="audit-pagination">
              <button className="btn-ghost" disabled={cursorStack.length === 0 || loading} onClick={() => {
                const stack = [...cursorStack];
                stack.pop();
                const previous = stack[stack.length - 1];
                setCursorStack(stack);
                load(previous);
              }}>
                <i className="ti ti-chevron-left" /> Prev
              </button>
              <span className="audit-pagination-label">Page {cursorStack.length + 1}</span>
              <button className="btn-ghost" disabled={!nextCursor || loading} onClick={() => {
                if (nextCursor) load(nextCursor, nextCursor);
              }}>
                Next <i className="ti ti-chevron-right" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
