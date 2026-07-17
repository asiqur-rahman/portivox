import type { ApiKeyRecord } from "../api";

export function ApiKeysPage({
  apiKeys,
  loading,
  createdKeyToken,
  onDismissToken,
  onNewKey,
  onRevokeKey,
  onCopy,
  onRefresh,
}: {
  apiKeys: ApiKeyRecord[];
  loading: boolean;
  createdKeyToken: string | null;
  onDismissToken: () => void;
  onNewKey: () => void;
  onRevokeKey: (id: string, name: string) => void;
  onCopy: (text: string) => void;
  onRefresh: () => void;
}) {
  const activeKeys = apiKeys.filter((key) => !key.revoked);

  return (
    <div className="page">
      {createdKeyToken && (
        <div className="info-banner" style={{ borderColor: "rgba(0,184,148,0.2)", background: "var(--green-bg)", marginBottom: 16 }}>
          <div className="info-badge" style={{ background: "var(--green)" }}>
            <i className="ti ti-check" />
          </div>
          <div style={{ flex: 1 }}>
            <div className="info-banner-label" style={{ color: "var(--green)" }}>Key ready - copy it now</div>
            <div className="info-banner-text token-callout-row" style={{ marginTop: 4 }}>
              <span className="url-pill token-pill" style={{ userSelect: "all", cursor: "text" }}>{createdKeyToken}</span>
              <span style={{ fontSize: 12, color: "var(--text-2)" }}>This token is shown only once.</span>
            </div>
          </div>
          <div className="token-callout-actions">
            <div className="icon-btn" onClick={() => onCopy(createdKeyToken)} title="Copy token">
              <i className="ti ti-copy" />
            </div>
            <i className="ti ti-x info-dismiss" onClick={onDismissToken} />
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-code" /> API keys</div>
          <div className="section-actions">
            <button className="btn-ghost" onClick={onRefresh} disabled={loading}>
              {loading ? <><i className="ti ti-loader-2 spin" /> Refreshing</> : <><i className="ti ti-refresh" /> Refresh</>}
            </button>
            <button data-testid="generate-key-button" className="btn-primary" onClick={onNewKey}>
              <i className="ti ti-plus" /> Generate key
            </button>
          </div>
        </div>

        {loading && activeKeys.length === 0 ? (
          <div className="skeleton-wrap">
            <div className="skeleton-line w-45" />
            <div className="skeleton-line w-90" />
            <div className="skeleton-line w-80" />
          </div>
        ) : activeKeys.length === 0 ? (
          <div className="empty">
            <i className="ti ti-key" />
            <div className="empty-title">No API keys yet</div>
            <div className="empty-desc">
              Generate a key for automation, CI pipelines, or controlled access to the Portivox API.
            </div>
            <button data-testid="generate-first-key-button" className="btn-primary empty-cta-btn" onClick={onNewKey}>
              <i className="ti ti-plus" /> Generate your first key
            </button>
          </div>
        ) : (
          <>
            <p style={{ padding: "0 2px 12px", margin: 0, fontSize: 12, color: "var(--text-3)", lineHeight: 1.6 }}>
              <i className="ti ti-info-circle" style={{ marginRight: 6, color: "var(--accent)" }} />
              A key not used by any device is automatically revoked after 24 hours. Register a device with it
              (<code>portivox register</code>) to keep it active.
            </p>
            <div className="mobile-card-list">
              {activeKeys.map((key) => (
                <article key={key.id} className="mobile-list-card">
                  <div className="mobile-list-card-head">
                    <div className="mobile-list-title">
                      <span className="mobile-list-icon"><i className="ti ti-key" /></span>
                      <div>
                        <strong>{key.name}</strong>
                        <span>{new Date(key.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <span className={`mobile-status ${(key.deviceCount ?? 0) > 0 ? "live" : ""}`}>
                      {(key.deviceCount ?? 0) > 0 ? `${key.deviceCount} device${key.deviceCount === 1 ? "" : "s"}` : "No device"}
                    </span>
                  </div>
                  <div className="mobile-chip-row">
                    {key.scopes.map((scope) => (
                      <span key={scope} className="chip chip-purple">{scope}</span>
                    ))}
                  </div>
                  {(key.deviceCount ?? 0) === 0 && (
                    <div className="mobile-card-meta block"><span style={{ color: "var(--yellow)" }}>Not used by any device — auto-revoked after 24h</span></div>
                  )}
                  <div className="mobile-card-actions">
                    <button className="stop-btn" disabled={loading} onClick={() => onRevokeKey(key.id, key.name)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scopes</th>
                  <th>Devices</th>
                  <th>Created</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeKeys.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <div style={{ width: 28, height: 28, borderRadius: 7, background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <i className="ti ti-key" style={{ fontSize: 13, color: "var(--accent)" }} />
                        </div>
                        <strong>{key.name}</strong>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {key.scopes.map((scope) => (
                          <span key={scope} className="chip chip-purple" style={{ fontSize: 10 }}>{scope}</span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {(key.deviceCount ?? 0) > 0 ? (
                        <span className="action-badge create"><i className="ti ti-device-desktop" />{key.deviceCount}</span>
                      ) : (
                        <span className="action-badge other" title="No device uses this key — it may be automatically revoked"><i className="ti ti-alert-triangle" />unused</span>
                      )}
                    </td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{new Date(key.createdAt).toLocaleDateString()}</td>
                    <td>
                      <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                        <button className="stop-btn" disabled={loading} onClick={() => onRevokeKey(key.id, key.name)}>
                          Delete
                        </button>
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
          <div className="section-title"><i className="ti ti-terminal-2" /> Developer CLI</div>
        </div>
        <div className="form-body">
          <div className="settings-section-copy">
            Advanced gateway override commands belong here for operators and developers, not for standard customer onboarding.
          </div>
          <div className="form-field">
            <label className="form-lbl">Custom gateway registration</label>
            <div className="code-block">
              <code>portivox register tk_YOUR_API_KEY --gateway wss://your-gateway.example.com/connect</code>
              <div className="icon-btn" style={{ color: "oklch(80% 0.10 213)" }} onClick={() => onCopy("portivox register tk_YOUR_API_KEY --gateway wss://your-gateway.example.com/connect")} title="Copy">
                <i className="ti ti-copy" />
              </div>
            </div>
          </div>
          <div className="form-field">
            <label className="form-lbl">Custom gateway tunnel open</label>
            <div className="code-block">
              <code>portivox open 3000 --gateway wss://your-gateway.example.com/connect</code>
              <div className="icon-btn" style={{ color: "oklch(80% 0.10 213)" }} onClick={() => onCopy("portivox open 3000 --gateway wss://your-gateway.example.com/connect")} title="Copy">
                <i className="ti ti-copy" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
