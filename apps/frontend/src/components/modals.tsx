import { useEffect, useRef, useState, type ReactNode } from "react";

export interface GlobalSearchItem {
  id: string;
  title: string;
  subtitle?: string;
  category: string;
  icon: string;
  onSelect: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 400 }} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            {danger && <i className="ti ti-alert-triangle" style={{ color: "var(--red)", marginRight: 6 }} />}
            {title}
          </div>
          <div className="icon-btn" onClick={onClose}><i className="ti ti-x" /></div>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, margin: 0 }}>{message}</p>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          {danger ? (
            <button className="btn-danger" onClick={onConfirm}>{confirmLabel}</button>
          ) : (
            <button className="btn-primary" onClick={onConfirm}>{confirmLabel}</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function InstallPromptModal({
  canInstallDirectly,
  onInstall,
  onDismiss,
}: {
  canInstallDirectly: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div className="modal install-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title"><i className="ti ti-download" /> Install Portivox App</div>
          <div className="icon-btn" onClick={onDismiss}><i className="ti ti-x" /></div>
        </div>
        <div className="modal-body">
          <p className="install-modal-copy">
            Install Portivox for faster access, a more app-like experience, and better offline readiness on desktop or mobile.
          </p>
          {!canInstallDirectly && (
            <div className="install-help">
              <strong>Manual install</strong>
              <span>Use your browser menu and choose “Install app” or “Add to Home Screen”.</span>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onDismiss}>Later</button>
          <button className="btn-primary" onClick={onInstall}>
            <i className="ti ti-device-mobile-down" />
            {canInstallDirectly ? "Install now" : "Got it"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GlobalSearchModal({
  open,
  query,
  setQuery,
  items,
  onClearRecent,
  onClose,
}: {
  open: boolean;
  query: string;
  setQuery: (value: string) => void;
  items: GlobalSearchItem[];
  onClearRecent: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, items.length]);

  if (!open) {
    return null;
  }

  const runItem = (index: number) => {
    const item = items[index];
    if (!item) return;
    onClose();
    item.onSelect();
  };

  const renderHighlightedText = (text: string) => {
    const needle = query.trim();
    if (!needle) {
      return text;
    }

    const lowerText = text.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    const parts: ReactNode[] = [];
    let cursor = 0;

    while (cursor < text.length) {
      const matchIndex = lowerText.indexOf(lowerNeedle, cursor);
      if (matchIndex < 0) {
        parts.push(text.slice(cursor));
        break;
      }
      if (matchIndex > cursor) {
        parts.push(text.slice(cursor, matchIndex));
      }
      parts.push(
        <mark key={`${text}-${matchIndex}`} className="global-search-highlight">
          {text.slice(matchIndex, matchIndex + needle.length)}
        </mark>,
      );
      cursor = matchIndex + needle.length;
    }

    return parts;
  };

  const groupedItems = items.reduce<Array<{ title: string; items: Array<{ item: GlobalSearchItem; index: number }> }>>((groups, item, index) => {
    const existing = groups[groups.length - 1];
    if (existing && existing.title === item.category) {
      existing.items.push({ item, index });
      return groups;
    }
    groups.push({ title: item.category, items: [{ item, index }] });
    return groups;
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal global-search-modal" onClick={(event) => event.stopPropagation()}>
        <div className="global-search-head">
          <div className="global-search-input-wrap">
            <i className="ti ti-search" />
            <input
              ref={inputRef}
              className="global-search-input"
              placeholder="Search pages, tunnels, API keys, and actions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onClose();
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((prev) => Math.min(prev + 1, Math.max(items.length - 1, 0)));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((prev) => Math.max(prev - 1, 0));
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  runItem(activeIndex);
                }
              }}
            />
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close search">
            <i className="ti ti-x" />
          </button>
        </div>

        <div className="global-search-results">
          {items.length === 0 ? (
            <div className="global-search-empty">
              <i className="ti ti-search-off" />
              <strong>No matches found</strong>
              <span>Try a page name, tunnel subdomain, API key label, or quick action.</span>
            </div>
          ) : (
            groupedItems.map((group) => (
              <section key={group.title} className="global-search-group">
                <div className="global-search-group-head">
                  <div className="global-search-group-title">{group.title}</div>
                  {group.title === "Recent searches" && (
                    <button type="button" className="global-search-clear" onClick={onClearRecent}>
                      Clear
                    </button>
                  )}
                </div>
                <div className="global-search-group-items">
                  {group.items.map(({ item, index }) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`global-search-item ${index === activeIndex ? "active" : ""}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => runItem(index)}
                    >
                      <span className="global-search-item-icon">
                        <i className={`ti ${item.icon}`} />
                      </span>
                      <span className="global-search-item-copy">
                        <strong>{renderHighlightedText(item.title)}</strong>
                        {item.subtitle && <span>{renderHighlightedText(item.subtitle)}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        <div className="global-search-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>/</kbd> Search</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}

export function NewTunnelModal({
  subdomain,
  setSubdomain,
  loading,
  onCreate,
  onClose,
}: {
  subdomain: string;
  setSubdomain: (value: string) => void;
  loading: boolean;
  onCreate: () => void;
  onClose: () => void;
}) {
  const host = window.location.hostname;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title"><i className="ti ti-topology-star-3" /> New tunnel</div>
          <div className="icon-btn" onClick={onClose}><i className="ti ti-x" /></div>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 16, lineHeight: 1.6 }}>
            Reserve a subdomain for a future client session. Once a matching Portivox client connects, traffic will be routed automatically.
          </p>
          <label className="form-lbl">Subdomain</label>
          <div className="modal-inline-input-row">
            <input
              data-testid="new-tunnel-subdomain"
              className="form-inp"
              style={{ flex: 1 }}
              placeholder="myapp"
              value={subdomain}
              onChange={(event) => setSubdomain(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              onKeyDown={(event) => event.key === "Enter" && onCreate()}
              autoFocus
            />
            <span className="modal-inline-suffix">
              .{host}
            </span>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 6 }}>
            Use 3-32 lowercase letters, numbers, or hyphens
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button data-testid="create-tunnel-submit" className="btn-primary" disabled={loading || subdomain.length < 3} onClick={onCreate}>
            {loading ? <><i className="ti ti-loader-2 spin" /> Creating...</> : <><i className="ti ti-plus" /> Create tunnel</>}
          </button>
        </div>
      </div>
    </div>
  );
}

const AVAILABLE_SCOPES: Array<{ value: string; label: string; desc: string }> = [
  { value: "tunnel:create", label: "tunnel:create", desc: "Open new tunnels" },
  { value: "tunnel:read", label: "tunnel:read", desc: "List and view tunnels" },
  { value: "tunnel:delete", label: "tunnel:delete", desc: "Close and delete tunnels" },
  { value: "key:manage", label: "key:manage", desc: "Create and delete API keys" },
];

export function NewKeyModal({
  name,
  setName,
  scopes,
  setScopes,
  loading,
  onCreate,
  onClose,
}: {
  name: string;
  setName: (value: string) => void;
  scopes: string[];
  setScopes: (value: string[]) => void;
  loading: boolean;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [dropOpen, setDropOpen] = useState(false);

  const toggleScope = (scope: string) => {
    setScopes(scopes.includes(scope) ? scopes.filter((item) => item !== scope) : [...scopes, scope]);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title"><i className="ti ti-key" /> Generate API key</div>
          <div className="icon-btn" onClick={onClose}><i className="ti ti-x" /></div>
        </div>
        <div className="modal-body">
          <div style={{ display: "grid", gap: 18 }}>
            <div className="modal-info-banner">
              <i className="ti ti-info-circle" style={{ color: "var(--accent)", fontSize: 15, flexShrink: 0 }} />
              <span className="modal-info-banner-text">
                Generated format: <strong style={{ color: "var(--accent)" }}>tk_</strong>
                <span style={{ color: "var(--text-3)" }}>{"x".repeat(20)}...</span>
              </span>
            </div>

            <div>
              <label className="form-lbl">Description</label>
              <input
                data-testid="new-key-description"
                className="form-inp"
                style={{ width: "100%" }}
                placeholder="e.g. ci-cd-deploy, production-server"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && !dropOpen && onCreate()}
                autoFocus
              />
              <p style={{ fontSize: 11, color: "var(--text-3)", marginTop: 5, lineHeight: 1.5 }}>
                Use a short label so this key is easy to identify later
              </p>
            </div>

            <div>
              <label className="form-lbl">Permissions</label>
              <div style={{ position: "relative" }}>
                <div
                  className="form-inp"
                  style={{
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    minHeight: 40,
                    userSelect: "none",
                  }}
                  onClick={() => setDropOpen((open) => !open)}
                >
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flex: 1 }}>
                    {scopes.length === 0 ? (
                      <span style={{ color: "var(--text-3)", fontSize: 12 }}>Select permissions...</span>
                    ) : (
                      scopes.map((scope) => (
                        <span key={scope} className="chip chip-purple" style={{ fontSize: 10 }}>{scope}</span>
                      ))
                    )}
                  </div>
                  <i
                    className={`ti ti-chevron-${dropOpen ? "up" : "down"}`}
                    style={{ fontSize: 13, color: "var(--text-3)", marginLeft: 8, flexShrink: 0 }}
                  />
                </div>

                {dropOpen && (
                  <div
                    style={{
                      position: "absolute",
                      top: "calc(100% + 4px)",
                      left: 0,
                      right: 0,
                      zIndex: 120,
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      boxShadow: "0 8px 28px rgba(0,0,0,0.14)",
                      overflow: "hidden",
                    }}
                  >
                    {AVAILABLE_SCOPES.map((scope, index) => {
                      const checked = scopes.includes(scope.value);
                      return (
                        <label
                          key={scope.value}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            padding: "11px 14px",
                            cursor: "pointer",
                            background: checked ? "var(--accent-bg)" : "transparent",
                            borderBottom: index < AVAILABLE_SCOPES.length - 1 ? "1px solid var(--border)" : "none",
                            transition: "background 0.1s",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleScope(scope.value)}
                            style={{ accentColor: "var(--accent)", width: 15, height: 15, flexShrink: 0 }}
                          />
                          <div style={{ flex: 1 }}>
                            <div
                              style={{
                                fontSize: 12.5,
                                fontWeight: 600,
                                fontFamily: "var(--mono)",
                                color: checked ? "var(--accent)" : "var(--text-1)",
                              }}
                            >
                              {scope.label}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}>{scope.desc}</div>
                          </div>
                          {checked && <i className="ti ti-check" style={{ fontSize: 13, color: "var(--accent)", flexShrink: 0 }} />}
                        </label>
                      );
                    })}
                    <div className="modal-dropdown-foot">
                      <button
                        type="button"
                        className="btn-ghost modal-dropdown-action"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setDropOpen(false);
                        }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {scopes.length === 0 && (
                <p style={{ fontSize: 11, color: "var(--red)", marginTop: 5 }}>
                  Select at least one permission
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button data-testid="generate-key-submit" className="btn-primary" disabled={loading || !name.trim() || scopes.length === 0} onClick={onCreate}>
            {loading ? <><i className="ti ti-loader-2 spin" /> Generating...</> : <><i className="ti ti-check" /> Generate key</>}
          </button>
        </div>
      </div>
    </div>
  );
}

