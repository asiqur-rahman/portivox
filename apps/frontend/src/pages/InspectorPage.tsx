import { useCallback, useEffect, useState } from "react";
import { GatewayApi, type CapturedRequestDetail, type CapturedRequestSummary, type TunnelRecord } from "../api";
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
  try {
    return atob(b64);
  } catch {
    return b64;
  }
}

function tryPrettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
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
  // CLI sessions are TCP tunnels — HTTP inspector has nothing to show for them.
  // Only expose HTTP (non-CLI) tunnels in the dropdown.
  const httpTunnels = tunnels.filter((t) => !t.isCliSession);
  const [subdomain, setSubdomain] = useState<string>(
    initialSubdomain ?? httpTunnels[0]?.subdomain ?? ""
  );
  const [requests, setRequests] = useState<CapturedRequestSummary[]>([]);
  const [selected, setSelected] = useState<CapturedRequestDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<"req-headers" | "req-body" | "res-headers" | "res-body">("res-body");
  const [clearing, setClearing] = useState(false);

  const fetchList = useCallback(() => {
    if (!subdomain) return;
    api.listInspectorRequests(subdomain)
      .then((data) => setRequests(data.requests))
      .catch(() => {});
  }, [api, subdomain]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  useEffect(() => {
    if (selected && !requests.some((request) => request.id === selected.id)) {
      setSelected(null);
    }
  }, [requests, selected]);

  useEffect(() => {
    if (!subdomain) {
      return;
    }

    let listTimer: ReturnType<typeof setTimeout> | null = null;
    let detailTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = subscribeGatewayLiveEvents((event) => {
      if (event.kind !== "inspector_changed") {
        return;
      }
      if (event.subdomain && event.subdomain !== subdomain) {
        return;
      }

      if (listTimer) {
        clearTimeout(listTimer);
      }
      listTimer = setTimeout(() => {
        listTimer = null;
        fetchList();
      }, 120);

      if (selected) {
        if (detailTimer) {
          clearTimeout(detailTimer);
        }
        detailTimer = setTimeout(() => {
          detailTimer = null;
          api.getInspectorRequest(subdomain, selected.id)
            .then((data) => setSelected(data.request))
            .catch(() => setSelected(null));
        }, 150);
      }
    });

    return () => {
      unsubscribe();
      if (listTimer) {
        clearTimeout(listTimer);
      }
      if (detailTimer) {
        clearTimeout(detailTimer);
      }
    };
  }, [api, fetchList, selected, subdomain]);

  const selectRequest = (id: string) => {
    setLoadingDetail(true);
    setActiveTab("res-body");
    api.getInspectorRequest(subdomain, id)
      .then((data) => setSelected(data.request))
      .catch(() => setSelected(null))
      .finally(() => setLoadingDetail(false));
  };

  const clearRequests = () => {
    setClearing(true);
    api.clearInspectorRequests(subdomain)
      .then(() => {
        setRequests([]);
        setSelected(null);
      })
      .catch(() => {})
      .finally(() => setClearing(false));
  };

  const copyAsCurl = () => {
    if (!selected) return;
    const base = `${window.location.protocol}//${subdomain}.${window.location.hostname}`;
    const command = buildCurlCommand(selected, base);
    navigator.clipboard.writeText(command).catch(() => {});
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
              <tr key={key}>
                <td>{key}</td>
                <td>{Array.isArray(value) ? value.join(", ") : String(value ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    const b64 = activeTab === "req-body" ? selected.requestBodyBase64 : selected.responseBodyBase64;
    const truncated = activeTab === "req-body" ? selected.requestBodyTruncated : selected.responseBodyTruncated;
    if (!b64) return <p className="inspector-no-body">Empty body.</p>;
    const raw = decodeBase64Body(b64);
    const display = tryPrettyJson(raw);
    return (
      <>
        {truncated && (
          <div className="inspector-truncated-note">
            <i className="ti ti-alert-triangle" />
            Body truncated at 64 KB, full payload not stored.
          </div>
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
          {httpTunnels.length > 0 && (
            <select
              className="form-inp inspector-tunnel-select"
              value={subdomain}
              onChange={(event) => {
                setSubdomain(event.target.value);
                setRequests([]);
                setSelected(null);
              }}
            >
              {httpTunnels.map((tunnel) => <option key={tunnel.id} value={tunnel.subdomain ?? ""}>{tunnel.subdomain ?? ""}</option>)}
            </select>
          )}
          <button className="btn-ghost" onClick={fetchList}><i className="ti ti-refresh" /> Refresh</button>
          <button className="btn-ghost" disabled={clearing || requests.length === 0} onClick={clearRequests}>
            <i className="ti ti-trash" /> Clear
          </button>
        </div>
      </div>

      {httpTunnels.length === 0 ? (
        <div className="empty">
          <i className="ti ti-plug-connected" />
          <div className="empty-title">No HTTP tunnels available</div>
          <div className="empty-desc">
            The traffic inspector captures <strong>HTTP</strong> requests only.
            Raw TCP sessions forward bytes directly and do not produce request logs.
            <br /><br />
            Start an HTTP tunnel from the tunnels page, then return here to inspect live request traffic.
          </div>
          <button className="btn-ghost empty-cta-btn" onClick={onBack}>
            <i className="ti ti-arrow-left" /> Back to tunnels
          </button>
        </div>
      ) : !subdomain ? (
        <div className="empty">
          <i className="ti ti-eye-off" />
          <div className="empty-title">No tunnel selected</div>
          <div className="empty-desc">Choose an HTTP tunnel to review live request traffic.</div>
        </div>
      ) : (
        <div className="inspector-layout">
          <div className="inspector-list-pane">
            <div className="inspector-list-head">
              <span className="inspector-subdomain">{subdomain}</span>
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
              <div className="inspector-empty-detail">
                <i className="ti ti-click" />
                <p>Select a request to review</p>
              </div>
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
                    {selected.durationMs !== null && (
                      <span className="inspector-detail-duration">{selected.durationMs} ms</span>
                    )}
                  </div>
                  <div className="inspector-detail-actions">
                    {loadingDetail && <i className="ti ti-loader-2 spin" style={{ fontSize: 16, color: "var(--text-3)" }} />}
                    <button className="btn-ghost" onClick={copyAsCurl} title="Copy as cURL">
                      <i className="ti ti-terminal" /> Copy cURL
                    </button>
                  </div>
                </div>

                <div className="inspector-tabs">
                  {(["res-body", "res-headers", "req-body", "req-headers"] as const).map((tab) => (
                    <button key={tab} className={`inspector-tab${activeTab === tab ? " active" : ""}`} onClick={() => setActiveTab(tab)}>
                      {tab === "res-body" ? "Response Body" : tab === "res-headers" ? "Response Headers" : tab === "req-body" ? "Request Body" : "Request Headers"}
                    </button>
                  ))}
                </div>

                <div className="inspector-body-scroll">
                  {renderBody()}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

