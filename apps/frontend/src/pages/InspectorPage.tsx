import { useCallback, useEffect, useMemo, useState } from "react";
import { GatewayApi, type CapturedRequestDetail, type CapturedRequestSummary, type TcpConnectionRecord, type TunnelRecord } from "../api";
import { subscribeGatewayLiveEvents } from "../app/live-events";

function methodClass(method: string): string {
  switch (method.toUpperCase()) {
    case "GET": return "method-get";
    case "POST": return "method-post";
    case "PUT": return "method-put";
    case "PATCH": return "method-patch";
    case "DELETE": return "method-delete";
    default: return "method-other";
  }
}

function statusClass(code: number | null, error: string | null): string {
  if (error) return "status-err";
  if (code === null) return "status-pending";
  if (code < 300) return "status-2xx";
  if (code < 400) return "status-3xx";
  if (code < 500) return "status-4xx";
  return "status-5xx";
}

function decodeBase64Body(b64: string): string {
  try { return atob(b64); } catch { return b64; }
}

function tryPrettyJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatDuration(openedAt: number, closedAt: number | null): string {
  const ms = (closedAt ?? Date.now()) - openedAt;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function buildCurlCommand(req: CapturedRequestDetail, baseUrl: string): string {
  const url = `${baseUrl}${req.path}`;
  const headerArgs = Object.entries(req.requestHeaders)
    .filter(([key, value]) => value !== undefined && key.toLowerCase() !== "host")
    .map(([key, value]) => `-H '${key}: ${Array.isArray(value) ? value.join(", ") : value}'`)
    .join(" \\\n  ");
  const body = req.requestBodyBase64 ? decodeBase64Body(req.requestBodyBase64) : "";
  const bodyArg = body ? ` \\\n  -d '${body.replace(/'/g, "'\\''")}' ` : "";
  return `curl -X ${req.method} '${url}' \\\n  ${headerArgs}${bodyArg}`;
}

function tunnelLabel(t: TunnelRecord): string {
  if (t.tunnelType === "tcp") return t.subdomain ?? (t.publicPort ? `port ${t.publicPort}` : "TCP tunnel");
  return t.subdomain ?? "";
}

export function InspectorPage({
  api,
  tunnels,
  initialSubdomain,
  onBack,
}: {
  api: GatewayApi;
  tunnels: TunnelRecord[];
  initialSubdomain: string | null;
  onBack: () => void;
}) {
  // Inspectable = HTTP tunnels (request capture, keyed by subdomain) plus TCP /
  // port tunnels (connection capture, keyed by inspectKey).
  const inspectable = useMemo(
    () => tunnels.filter((t) => (t.tunnelType === "tcp" ? !!t.inspectKey : !!t.subdomain)),
    [tunnels],
  );

  const [selectedId, setSelectedId] = useState<string>(() => {
    if (initialSubdomain) {
      const match = inspectable.find((t) => t.subdomain === initialSubdomain);
      if (match) return match.id;
    }
    return inspectable[0]?.id ?? "";
  });

  const current = inspectable.find((t) => t.id === selectedId) ?? null;
  const mode: "http" | "tcp" = current?.tunnelType === "tcp" ? "tcp" : "http";
  const httpKey = mode === "http" ? current?.subdomain ?? "" : "";
  const tcpKey = mode === "tcp" ? current?.inspectKey ?? "" : "";
  const eventKey = mode === "tcp" ? tcpKey : httpKey;

  // HTTP state
  const [requests, setRequests] = useState<CapturedRequestSummary[]>([]);
  const [selected, setSelected] = useState<CapturedRequestDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<"req-headers" | "req-body" | "res-headers" | "res-body">("res-body");
  // TCP state
  const [connections, setConnections] = useState<TcpConnectionRecord[]>([]);
  const [clearing, setClearing] = useState(false);

  const fetchList = useCallback(() => {
    if (mode === "http") {
      if (!httpKey) return;
      api.listInspectorRequests(httpKey).then((data) => setRequests(data.requests)).catch(() => {});
    } else {
      if (!tcpKey) return;
      api.listTcpConnections(tcpKey).then((data) => setConnections(data.connections)).catch(() => {});
    }
  }, [api, mode, httpKey, tcpKey]);

  useEffect(() => { fetchList(); }, [fetchList]);

  useEffect(() => {
    if (selected && !requests.some((request) => request.id === selected.id)) setSelected(null);
  }, [requests, selected]);

  // Live refresh on inspector_changed for the selected tunnel.
  useEffect(() => {
    if (!eventKey) return;
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeGatewayLiveEvents((event) => {
      if (event.kind !== "inspector_changed") return;
      if (event.subdomain && event.subdomain !== eventKey) return;
      if (listTimer) clearTimeout(listTimer);
      listTimer = setTimeout(() => { listTimer = null; fetchList(); }, 120);
    });
    return () => { unsubscribe(); if (listTimer) clearTimeout(listTimer); };
  }, [fetchList, eventKey]);

  // TCP byte counts update mid-connection without events — poll while viewing.
  useEffect(() => {
    if (mode !== "tcp" || !tcpKey) return;
    const timer = setInterval(fetchList, 3000);
    return () => clearInterval(timer);
  }, [mode, tcpKey, fetchList]);

  const selectRequest = (id: string) => {
    setLoadingDetail(true);
    setActiveTab("res-body");
    api.getInspectorRequest(httpKey, id).then((data) => setSelected(data.request)).catch(() => setSelected(null)).finally(() => setLoadingDetail(false));
  };

  const clearAll = () => {
    setClearing(true);
    const done = () => { setClearing(false); };
    if (mode === "http") {
      api.clearInspectorRequests(httpKey).then(() => { setRequests([]); setSelected(null); }).catch(() => {}).finally(done);
    } else {
      api.clearTcpConnections(tcpKey).then(() => setConnections([])).catch(() => {}).finally(done);
    }
  };

  const copyAsCurl = () => {
    if (!selected) return;
    const base = `${window.location.protocol}//${httpKey}.${window.location.hostname}`;
    navigator.clipboard.writeText(buildCurlCommand(selected, base)).catch(() => {});
  };

  const renderBody = () => {
    if (!selected) return null;
    if (activeTab === "req-headers" || activeTab === "res-headers") {
      const headers = activeTab === "req-headers" ? selected.requestHeaders : selected.responseHeaders;
      const entries = Object.entries(headers).filter(([, value]) => value !== undefined);
      if (entries.length === 0) return <p className="inspector-no-body">No headers.</p>;
      return (
        <table className="inspector-headers-tbl">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key}><td>{key}</td><td>{Array.isArray(value) ? value.join(", ") : String(value ?? "")}</td></tr>
            ))}
          </tbody>
        </table>
      );
    }
    const b64 = activeTab === "req-body" ? selected.requestBodyBase64 : selected.responseBodyBase64;
    const truncated = activeTab === "req-body" ? selected.requestBodyTruncated : selected.responseBodyTruncated;
    if (!b64) return <p className="inspector-no-body">Empty body.</p>;
    const display = tryPrettyJson(decodeBase64Body(b64));
    return (
      <>
        {truncated && (
          <div className="inspector-truncated-note"><i className="ti ti-alert-triangle" />Body truncated at 64 KB, full payload not stored.</div>
        )}
        <pre className="inspector-body-pre">{display}</pre>
      </>
    );
  };

  const selectedReqInfo = selected ? requests.find((request) => request.id === selected.id) : null;

  return (
    <div className="page">
      <div className="inspector-toolbar">
        <div className="inspector-toolbar-left">
          <button className="btn-ghost" onClick={onBack}><i className="ti ti-arrow-left" /></button>
          <span className="inspector-toolbar-title">Traffic inspector</span>
          <span className="inspector-live-badge"><span className="inspector-live-dot" />Live capture</span>
        </div>
        <div className="inspector-toolbar-right">
          {inspectable.length > 0 && (
            <select
              className="form-inp inspector-tunnel-select"
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setRequests([]); setSelected(null); setConnections([]);
              }}
            >
              {inspectable.map((tunnel) => (
                <option key={tunnel.id} value={tunnel.id}>
                  {tunnel.tunnelType === "tcp" ? `${tunnelLabel(tunnel)} · TCP` : tunnelLabel(tunnel)}
                </option>
              ))}
            </select>
          )}
          <button className="btn-ghost" onClick={fetchList}><i className="ti ti-refresh" /> Refresh</button>
          <button className="btn-ghost" disabled={clearing || (mode === "http" ? requests.length === 0 : connections.length === 0)} onClick={clearAll}>
            <i className="ti ti-trash" /> Clear
          </button>
        </div>
      </div>

      {inspectable.length === 0 ? (
        <div className="empty">
          <i className="ti ti-plug-connected" />
          <div className="empty-title">No tunnels to inspect</div>
          <div className="empty-desc">
            Open a tunnel from the tunnels page, then return here. HTTP tunnels show request/response
            traffic; raw TCP / port tunnels show live connection activity.
          </div>
          <button className="btn-ghost empty-cta-btn" onClick={onBack}><i className="ti ti-arrow-left" /> Back to tunnels</button>
        </div>
      ) : !current ? (
        <div className="empty">
          <i className="ti ti-eye-off" />
          <div className="empty-title">No tunnel selected</div>
          <div className="empty-desc">Choose a tunnel to review its live traffic.</div>
        </div>
      ) : mode === "tcp" ? (
        <div className="section">
          <div className="section-head">
            <div className="section-title"><i className="ti ti-plug-connected" /> {connections.length} connection{connections.length !== 1 ? "s" : ""} · {tunnelLabel(current)}</div>
          </div>
          <p style={{ padding: "0 18px", margin: "0 0 8px", fontSize: 12, color: "var(--text-3)" }}>
            Raw TCP forwards bytes directly, so there are no HTTP request logs. This shows live
            connection activity (source IP, bytes, duration) for the exposed port.
          </p>
          {connections.length === 0 ? (
            <div className="inspector-list-empty" style={{ padding: 28 }}>
              <i className="ti ti-antenna-bars-1" />
              <p className="inspector-list-empty-title">Waiting for connections...</p>
              <p className="inspector-list-empty-copy">Connect to the exposed port to see activity here.</p>
            </div>
          ) : (
            <table className="tbl">
              <thead><tr><th>Source IP</th><th>Opened</th><th>Duration</th><th>In</th><th>Out</th><th>Status</th></tr></thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}>{c.remoteIp || "unknown"}</td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{new Date(c.openedAt).toLocaleTimeString()}</td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{formatDuration(c.openedAt, c.closedAt)}</td>
                    <td style={{ fontSize: 12 }}>{formatBytes(c.bytesIn)}</td>
                    <td style={{ fontSize: 12 }}>{formatBytes(c.bytesOut)}</td>
                    <td>
                      <div className={`tunnel-status-inline ${c.closedAt === null ? "live" : "offline"}`}>
                        <span className={`status-dot ${c.closedAt === null ? "dot-green" : "dot-gray"}`} />
                        {c.closedAt === null ? "Open" : "Closed"}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="inspector-layout">
          <div className="inspector-list-pane">
            <div className="inspector-list-head">
              <span className="inspector-subdomain">{httpKey}</span>
              <span className="inspector-request-count">{requests.length} request{requests.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="inspector-list-scroll">
              {requests.length === 0 ? (
                <div className="inspector-list-empty">
                  <i className="ti ti-antenna-bars-1" />
                  <p className="inspector-list-empty-title">Waiting for HTTP requests...</p>
                  <p className="inspector-list-empty-copy">Send a request to your public URL to see it here.</p>
                </div>
              ) : requests.map((request) => (
                <div key={request.id} className={`inspector-row${selected?.id === request.id ? " active" : ""}`} onClick={() => selectRequest(request.id)}>
                  <div className="inspector-row-top">
                    <span className={`inspector-method ${methodClass(request.method)}`}>{request.method}</span>
                    <span className={`inspector-status ${statusClass(request.statusCode, request.error)}`}>
                      {request.error ? "ERR" : request.statusCode ?? "..."}
                    </span>
                    <span className="inspector-path">{request.path}</span>
                  </div>
                  <div className="inspector-row-meta">
                    <span>{new Date(request.capturedAt).toLocaleTimeString()}</span>
                    {request.durationMs !== null && <span className="inspector-duration">{request.durationMs} ms</span>}
                    {request.error && <span className="inspector-error-text">{request.error}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="inspector-detail-pane">
            {!selected ? (
              <div className="inspector-empty-detail"><i className="ti ti-click" /><p>Select a request to review</p></div>
            ) : (
              <>
                <div className="inspector-detail-head">
                  <div className="inspector-detail-title">
                    <span className={`inspector-method ${methodClass(selected.method)}`}>{selected.method}</span>
                    <span className="inspector-detail-path">{selected.path}</span>
                    {selectedReqInfo && (
                      <span className={`inspector-status ${statusClass(selected.statusCode, selected.error)}`}>
                        {selected.error ? "ERR" : selected.statusCode ?? "..."}
                      </span>
                    )}
                    {selected.durationMs !== null && <span className="inspector-detail-duration">{selected.durationMs} ms</span>}
                  </div>
                  <div className="inspector-detail-actions">
                    {loadingDetail && <i className="ti ti-loader-2 spin" style={{ fontSize: 16, color: "var(--text-3)" }} />}
                    <button className="btn-ghost" onClick={copyAsCurl} title="Copy as cURL"><i className="ti ti-terminal" /> Copy cURL</button>
                  </div>
                </div>

                <div className="inspector-tabs">
                  {(["res-body", "res-headers", "req-body", "req-headers"] as const).map((tab) => (
                    <button key={tab} className={`inspector-tab${activeTab === tab ? " active" : ""}`} onClick={() => setActiveTab(tab)}>
                      {tab === "res-body" ? "Response Body" : tab === "res-headers" ? "Response Headers" : tab === "req-body" ? "Request Body" : "Request Headers"}
                    </button>
                  ))}
                </div>

                <div className="inspector-body-scroll">{renderBody()}</div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
