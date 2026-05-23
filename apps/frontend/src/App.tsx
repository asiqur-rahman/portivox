import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GatewayApi, type ApiKeyRecord, type AuditItem, type CapturedRequestDetail, type CapturedRequestSummary, type GatewayStatus, type TcpPortMapping, type TunnelRecord } from "./api";
import "./styles.css";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "";

type Page = "tunnels" | "devices" | "ai" | "usage" | "api" | "org" | "settings" | "billing"
  | "admin:overview" | "admin:audit" | "admin:gateway" | "admin:tcp"
  | "inspector";
type Theme = "light" | "dark";
type AuthTab = "login" | "register";

interface Toast {
  id: number;
  message: string;
  type: "default" | "green" | "red";
}

interface UserInfo {
  email: string;
  name: string;
  initials: string;
  role: string;
}

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

// GatewayStatus is imported from api.ts — see import above

const PAGE_TITLES: Record<Page, string> = {
  tunnels: "Tunnels",
  devices: "Devices",
  ai: "AI Assistant",
  usage: "Usage & Logs",
  api: "API Keys",
  org: "Organisation",
  settings: "Settings",
  billing: "Billing",
  "admin:overview": "Admin Overview",
  "admin:audit":    "Audit Log",
  "admin:gateway":  "Gateway Control",
  "admin:tcp":      "TCP Port Mappings",
  "inspector":      "Traffic Inspector",
};

function isAdminPage(p: Page): boolean { return p.startsWith("admin:"); }
function hasAdminRole(role?: string): boolean { return role === "admin" || role === "owner"; }

const AI_QUICK_ACTIONS = [
  { icon: "ti-plug", title: "Expose local port", desc: "Share a dev server via a secure tunnel", prompt: "How do I expose my local port 3000 to the internet?" },
  { icon: "ti-stethoscope", title: "Diagnose idle tunnel", desc: "Investigate why connections aren't arriving", prompt: "Why is my tunnel showing zero inbound connections?" },
  { icon: "ti-database", title: "Tunnel a database", desc: "Securely expose PostgreSQL, MySQL, or Redis", prompt: "How do I create a TCP tunnel for my PostgreSQL database?" },
  { icon: "ti-shield-lock", title: "Security audit", desc: "Review open tunnels for exposure risks", prompt: "Audit my current tunnels and suggest security improvements" },
  { icon: "ti-code", title: "CLI command help", desc: "Generate the exact portivox command you need", prompt: "What portivox CLI command opens a tunnel with IP protection enabled?" },
  { icon: "ti-clock-play", title: "Auto-close rules", desc: "Stop tunnels automatically after idle timeout", prompt: "How do I configure tunnels to close automatically after 1 hour of inactivity?" },
];

// toastSeq is kept as a module-level integer only to seed the initial ref.
// The ref itself lives inside App — see useRef(0) below.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveInitials(email: string): string {
  const name = email.split("@")[0].replace(/[^a-zA-Z\s]/g, " ").trim();
  const parts = name.split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.substring(0, 2).toUpperCase();
}

function deriveName(email: string): string {
  return email
    .split("@")[0]
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function getTunnelUrl(subdomain: string): string {
  const proto = window.location.protocol; // "http:" or "https:"
  const host = window.location.hostname;
  return `${proto}//${subdomain}.${host}`;
}

function getWsGatewayUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/connect`;
}

function saveSession(token: string, user: UserInfo): void {
  try {
    localStorage.setItem("ptx-session", JSON.stringify({ token, ...user }));
  } catch {
    // ignore
  }
}

function clearSession(): void {
  localStorage.removeItem("ptx-session");
}

function loadSession(): { token: string; user: UserInfo } | null {
  try {
    const raw = localStorage.getItem("ptx-session");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string; email?: string; name?: string; initials?: string; role?: string };
    if (!parsed.token || !parsed.email) return null;
    return {
      token: parsed.token,
      user: {
        email: parsed.email,
        name: parsed.name ?? deriveName(parsed.email),
        initials: parsed.initials ?? deriveInitials(parsed.email),
        role: parsed.role ?? "owner",
      },
    };
  } catch {
    return null;
  }
}

// ─── ConfirmModal ─────────────────────────────────────────────────────────────

function ConfirmModal({ title, message, confirmLabel, danger, onConfirm, onClose }: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
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
          {danger
            ? <button className="btn-danger" onClick={onConfirm}>{confirmLabel}</button>
            : <button className="btn-primary" onClick={onConfirm}>{confirmLabel}</button>
          }
        </div>
      </div>
    </div>
  );
}

// ─── NewTunnelModal ───────────────────────────────────────────────────────────

function NewTunnelModal({
  subdomain, setSubdomain, loading, onCreate, onClose,
}: {
  subdomain: string;
  setSubdomain: (v: string) => void;
  loading: boolean;
  onCreate: () => void;
  onClose: () => void;
}) {
  const host = window.location.hostname;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title"><i className="ti ti-topology-star-3" /> New tunnel</div>
          <div className="icon-btn" onClick={onClose}><i className="ti ti-x" /></div>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 16, lineHeight: 1.6 }}>
            Reserve a subdomain. Once a client connects using this subdomain, traffic
            will be routed automatically.
          </p>
          <label className="form-lbl">Subdomain</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <input
              className="form-inp"
              style={{ flex: 1 }}
              placeholder="myapp"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && onCreate()}
              autoFocus
            />
            <span style={{ fontSize: 12, color: "var(--text-3)", whiteSpace: "nowrap" }}>
              .{host}
            </span>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 6 }}>
            3–32 chars · lowercase letters, numbers, hyphens only
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={loading || subdomain.length < 3} onClick={onCreate}>
            {loading ? <><i className="ti ti-loader-2 spin" /> Creating…</> : <><i className="ti ti-plus" /> Create tunnel</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── NewKeyModal ──────────────────────────────────────────────────────────────

const AVAILABLE_SCOPES: { value: string; label: string; desc: string }[] = [
  { value: "tunnel:create", label: "tunnel:create", desc: "Open new tunnels" },
  { value: "tunnel:read",   label: "tunnel:read",   desc: "List and view tunnels" },
  { value: "tunnel:delete", label: "tunnel:delete", desc: "Close and delete tunnels" },
  { value: "key:manage",    label: "key:manage",    desc: "Create and revoke API keys" },
];

function NewKeyModal({
  name, setName, scopes, setScopes, loading, onCreate, onClose,
}: {
  name: string;
  setName: (v: string) => void;
  scopes: string[];
  setScopes: (v: string[]) => void;
  loading: boolean;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [dropOpen, setDropOpen] = useState(false);

  const toggleScope = (scope: string) => {
    setScopes(scopes.includes(scope) ? scopes.filter((s) => s !== scope) : [...scopes, scope]);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title"><i className="ti ti-key" /> Generate API key</div>
          <div className="icon-btn" onClick={onClose}><i className="ti ti-x" /></div>
        </div>
        <div className="modal-body">
          <div style={{ display: "grid", gap: 18 }}>

            {/* Key format preview */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              background: "var(--accent-bg)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "9px 13px",
            }}>
              <i className="ti ti-info-circle" style={{ color: "var(--accent)", fontSize: 15, flexShrink: 0 }} />
              <span style={{ fontSize: 11.5, color: "var(--text-2)", fontFamily: "var(--mono)" }}>
                Generated format:&nbsp;
                <strong style={{ color: "var(--accent)" }}>tk_</strong>
                <span style={{ color: "var(--text-3)" }}>{"x".repeat(20)}…</span>
              </span>
            </div>

            {/* Description (used as key name) */}
            <div>
              <label className="form-lbl">Description</label>
              <input
                className="form-inp"
                style={{ width: "100%" }}
                placeholder="e.g. ci-cd-deploy, production-server"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !dropOpen && onCreate()}
                autoFocus
              />
              <p style={{ fontSize: 11, color: "var(--text-3)", marginTop: 5, lineHeight: 1.5 }}>
                A short label to identify this key later
              </p>
            </div>

            {/* Scope multi-select checklist dropdown */}
            <div>
              <label className="form-lbl">Permissions</label>
              <div style={{ position: "relative" }}>

                {/* Trigger */}
                <div
                  className="form-inp"
                  style={{
                    cursor: "pointer", display: "flex", alignItems: "center",
                    justifyContent: "space-between", minHeight: 40, userSelect: "none",
                  }}
                  onClick={() => setDropOpen((o) => !o)}
                >
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flex: 1 }}>
                    {scopes.length === 0
                      ? <span style={{ color: "var(--text-3)", fontSize: 12 }}>Select permissions…</span>
                      : scopes.map((s) => (
                          <span key={s} className="chip chip-purple" style={{ fontSize: 10 }}>{s}</span>
                        ))}
                  </div>
                  <i
                    className={`ti ti-chevron-${dropOpen ? "up" : "down"}`}
                    style={{ fontSize: 13, color: "var(--text-3)", marginLeft: 8, flexShrink: 0 }}
                  />
                </div>

                {/* Checklist panel */}
                {dropOpen && (
                  <div style={{
                    position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 120,
                    background: "var(--bg-card)", border: "1px solid var(--border)",
                    borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,0.14)", overflow: "hidden",
                  }}>
                    {AVAILABLE_SCOPES.map((scope, idx) => {
                      const checked = scopes.includes(scope.value);
                      return (
                        <label
                          key={scope.value}
                          style={{
                            display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
                            cursor: "pointer", background: checked ? "var(--accent-bg)" : "transparent",
                            borderBottom: idx < AVAILABLE_SCOPES.length - 1 ? "1px solid var(--border)" : "none",
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
                            <div style={{
                              fontSize: 12.5, fontWeight: 600, fontFamily: "var(--mono)",
                              color: checked ? "var(--accent)" : "var(--text-1)",
                            }}>{scope.label}</div>
                            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}>{scope.desc}</div>
                          </div>
                          {checked && <i className="ti ti-check" style={{ fontSize: 13, color: "var(--accent)", flexShrink: 0 }} />}
                        </label>
                      );
                    })}
                    <div style={{ padding: "9px 14px", background: "var(--bg-secondary)", borderTop: "1px solid var(--border)" }}>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ width: "100%", fontSize: 12, padding: "6px 0" }}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDropOpen(false); }}
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
          <button
            className="btn-primary"
            disabled={loading || !name.trim() || scopes.length === 0}
            onClick={onCreate}
          >
            {loading
              ? <><i className="ti ti-loader-2 spin" /> Generating…</>
              : <><i className="ti ti-check" /> Generate key</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AuthScreen ───────────────────────────────────────────────────────────────

function AuthScreen({
  authTab, setAuthTab, theme, setTheme,
  loginEmail, setLoginEmail, loginPassword, setLoginPassword, loginPassShow, setLoginPassShow,
  regFirstName, setRegFirstName, regLastName, setRegLastName,
  regEmail, setRegEmail, regPassword, setRegPassword, regPassShow, setRegPassShow,
  loading, doLogin, doRegister,
}: {
  authTab: AuthTab; setAuthTab: (t: AuthTab) => void;
  theme: Theme; setTheme: (t: Theme) => void;
  loginEmail: string; setLoginEmail: (v: string) => void;
  loginPassword: string; setLoginPassword: (v: string) => void;
  loginPassShow: boolean; setLoginPassShow: (v: boolean) => void;
  regFirstName: string; setRegFirstName: (v: string) => void;
  regLastName: string; setRegLastName: (v: string) => void;
  regEmail: string; setRegEmail: (v: string) => void;
  regPassword: string; setRegPassword: (v: string) => void;
  regPassShow: boolean; setRegPassShow: (v: boolean) => void;
  loading: boolean; doLogin: () => void; doRegister: () => void;
}) {
  return (
    <div id="screen-auth">
      {/* ── Left panel ────────────────────────── */}
      <div className="auth-left">
        <div className="auth-left-inner">
          <div className="auth-brand">
            <div className="auth-brand-icon"><i className="ti ti-topology-star" /></div>
            <span className="auth-brand-name">Portivox <span className="auth-brand-badge">AI</span></span>
          </div>
          <h1 className="auth-headline">Secure tunnels.<br /><em>AI superpowers.</em></h1>
          <p className="auth-sub">
            Expose local ports to the internet in seconds — with intelligent monitoring,
            auto-optimization, and AI-assisted setup built right in.
          </p>
          <div className="auth-features">
            <div className="auth-feature">
              <div className="auth-feature-dot"><i className="ti ti-shield-lock" /></div>
              <span>End-to-end encrypted WebSocket tunnels</span>
            </div>
            <div className="auth-feature">
              <div className="auth-feature-dot"><i className="ti ti-sparkles" /></div>
              <span>AI-powered diagnostics &amp; insights</span>
            </div>
            <div className="auth-feature">
              <div className="auth-feature-dot"><i className="ti ti-clock" /></div>
              <span>Up in seconds — no config needed</span>
            </div>
            <div className="auth-feature">
              <div className="auth-feature-dot"><i className="ti ti-building" /></div>
              <span>Team &amp; enterprise org management</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right panel ───────────────────────── */}
      <div className="auth-right">
        <div className="auth-theme-top">
          <div className="theme-toggle" style={{ width: "fit-content" }}>
            <button className={`theme-btn ${theme === "light" ? "active" : ""}`} onClick={() => setTheme("light")}><i className="ti ti-sun" /></button>
            <button className={`theme-btn ${theme === "dark" ? "active" : ""}`} onClick={() => setTheme("dark")}><i className="ti ti-moon" /></button>
          </div>
        </div>

        <div className="auth-tabs">
          <button className={`auth-tab ${authTab === "login" ? "active" : ""}`} onClick={() => setAuthTab("login")}>Sign in</button>
          <button className={`auth-tab ${authTab === "register" ? "active" : ""}`} onClick={() => setAuthTab("register")}>Create account</button>
        </div>

        {/* LOGIN */}
        <div className={`auth-panel ${authTab === "login" ? "active" : ""}`}>
          <div className="auth-form-title">Welcome back</div>
          <div className="auth-form-sub">Sign in to your Portivox workspace</div>
          <div className="auth-form">
            <div>
              <label className="field-label" htmlFor="login-email">Email address</label>
              <input className="field-input" id="login-email" type="email" placeholder="you@company.com"
                autoComplete="email" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doLogin()} />
            </div>
            <div>
              <label className="field-label" htmlFor="login-pass">Password</label>
              <div className="field-input-wrap">
                <input className="field-input" id="login-pass" type={loginPassShow ? "text" : "password"}
                  placeholder="••••••••" autoComplete="current-password"
                  value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doLogin()} />
                <i className={`ti ${loginPassShow ? "ti-eye-off" : "ti-eye"} field-eye`}
                  onClick={() => setLoginPassShow(!loginPassShow)} />
              </div>
            </div>
            <button className="auth-submit" disabled={loading} onClick={doLogin}>
              {loading ? <><i className="ti ti-loader-2 spin" /> Signing in…</> : <><i className="ti ti-login" /> Sign in</>}
            </button>
          </div>
          <div className="auth-footer-note">
            Don't have an account?{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); setAuthTab("register"); }}>Create one free →</a>
          </div>
        </div>

        {/* REGISTER */}
        <div className={`auth-panel ${authTab === "register" ? "active" : ""}`}>
          <div className="auth-form-title">Create your account</div>
          <div className="auth-form-sub">Get started free — no credit card required</div>
          <div className="auth-form">
            <div className="field-row">
              <div>
                <label className="field-label">First name</label>
                <input className="field-input" type="text" placeholder="First name"
                  value={regFirstName} onChange={(e) => setRegFirstName(e.target.value)} />
              </div>
              <div>
                <label className="field-label">Last name</label>
                <input className="field-input" type="text" placeholder="Last name"
                  value={regLastName} onChange={(e) => setRegLastName(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="field-label">Work email</label>
              <input className="field-input" type="email" placeholder="you@company.com"
                value={regEmail} onChange={(e) => setRegEmail(e.target.value)} />
            </div>
            <div>
              <label className="field-label">Password</label>
              <div className="field-input-wrap">
                <input className="field-input" type={regPassShow ? "text" : "password"}
                  placeholder="Min. 8 characters" value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doRegister()} />
                <i className={`ti ${regPassShow ? "ti-eye-off" : "ti-eye"} field-eye`}
                  onClick={() => setRegPassShow(!regPassShow)} />
              </div>
            </div>
            <button className="auth-submit" disabled={loading} onClick={doRegister}>
              {loading ? <><i className="ti ti-loader-2 spin" /> Creating account…</> : <><i className="ti ti-user-plus" /> Create account</>}
            </button>
          </div>
          <div className="auth-footer-note">
            Already have an account?{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); setAuthTab("login"); }}>Sign in →</a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── TunnelsPage ──────────────────────────────────────────────────────────────

function TunnelsPage({
  tunnels, loading, gatewayStatus, aiInsightVisible, setAiInsightVisible,
  onRefresh, onNewTunnel, onDeleteTunnel, onCopy, onInspect,
}: {
  tunnels: TunnelRecord[];
  loading: boolean;
  gatewayStatus: GatewayStatus | null;
  aiInsightVisible: boolean;
  setAiInsightVisible: (v: boolean) => void;
  onRefresh: () => void;
  onNewTunnel: () => void;
  onDeleteTunnel: (id: string, subdomain: string) => void;
  onCopy: (text: string) => void;
  onInspect: (subdomain: string) => void;
}) {
  return (
    <div className="page">
      <div className="metrics">
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-plug-connected" /></div>
            Active tunnels
          </div>
          <div className="metric-val">{tunnels.filter((t) => t.active).length}</div>
          <div className="metric-sub">
            {tunnels.filter((t) => t.active).length > 0
              ? <span className="up">↑ {tunnels.filter((t) => t.active).length} connected</span>
              : tunnels.length > 0 ? `${tunnels.length} reserved, none connected` : "None active"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-server" /></div>
            Gateway status
          </div>
          <div className="metric-val" style={{ fontSize: 15, paddingTop: 5, fontWeight: 600 }}>
            {gatewayStatus == null ? "…" : gatewayStatus.ready ? "Ready" : "Unavailable"}
          </div>
          <div className={`metric-sub ${gatewayStatus?.ready ? "up" : ""}`}>
            {gatewayStatus?.maintenanceMode
              ? "⚠ Maintenance mode"
              : gatewayStatus?.draining
                ? "⚠ Draining"
                : gatewayStatus?.ready
                  ? "↑ All systems operational"
                  : "Status unknown"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-transfer" /></div>
            Data transferred
          </div>
          <div className="metric-val" style={{ fontSize: 22 }}>—</div>
          <div className="metric-sub">Metrics coming soon</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-activity" /></div>
            Avg latency
          </div>
          <div className="metric-val" style={{ fontSize: 22 }}>—</div>
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
                : tunnels.filter((t) => t.active).length === 0
                  ? <>You have <strong>{tunnels.length}</strong> reserved subdomain{tunnels.length !== 1 ? "s" : ""} but <strong>no live connections</strong>. Run <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>portivox open &lt;port&gt; --subdomain &lt;name&gt;</code> to activate one.</>
                  : <>You have <strong>{tunnels.filter((t) => t.active).length}</strong> live tunnel{tunnels.filter((t) => t.active).length !== 1 ? "s" : ""}. Run <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>portivox list</code> from the CLI to view status on any device.</>}
            </div>
          </div>
          <i className="ti ti-x ai-dismiss" onClick={() => setAiInsightVisible(false)} />
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-topology-star-3" /> Live sessions</div>
          <div className="section-actions">
            <button className="btn-ghost" onClick={onRefresh} disabled={loading}>
              {loading ? <><i className="ti ti-loader-2 spin" /> Refreshing</> : <><i className="ti ti-refresh" /> Refresh</>}
            </button>
            <button className="btn-primary" onClick={onNewTunnel}>
              <i className="ti ti-plus" /> New tunnel
            </button>
          </div>
        </div>

        {tunnels.length === 0 ? (
          <div className="empty">
            <i className="ti ti-topology-star-3" />
            <div className="empty-title">No active tunnels</div>
            <div className="empty-desc">
              Start a tunnel from the CLI with <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>portivox open &lt;port&gt;</code>,
              or click below to reserve a subdomain.
            </div>
            <button className="btn-primary" style={{ margin: "0 auto" }} onClick={onNewTunnel}>
              <i className="ti ti-plus" /> New tunnel
            </button>
          </div>
        ) : (
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
                return (
                  <tr key={tunnel.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <div style={{ width: 28, height: 28, borderRadius: 7, background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <i className="ti ti-topology-star-3" style={{ fontSize: 14, color: "var(--accent)" }} />
                        </div>
                        <strong>{tunnel.subdomain}</strong>
                      </div>
                    </td>
                    <td>
                      <span className="url-pill">{url}</span>
                    </td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>
                      {new Date(tunnel.createdAt).toLocaleString()}
                    </td>
                    <td>
                      {tunnel.active
                        ? <><span className="status-dot dot-green" />Live</>
                        : <><span className="status-dot dot-gray" /><span style={{ color: "var(--text-3)" }}>Reserved</span></>}
                    </td>
                    <td>
                      <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                        {tunnel.active && (
                          <div className="icon-btn" title="Inspect traffic" onClick={() => onInspect(tunnel.subdomain)}>
                            <i className="ti ti-eye" />
                          </div>
                        )}
                        <div className="icon-btn" title="Copy URL" onClick={() => onCopy(url)}>
                          <i className="ti ti-copy" />
                        </div>
                        <div className="icon-btn" title="Open in browser"
                          onClick={() => window.open(url, "_blank", "noreferrer")}>
                          <i className="ti ti-external-link" />
                        </div>
                        <button className="stop-btn" disabled={loading}
                          onClick={() => onDeleteTunnel(tunnel.id, tunnel.subdomain)}>
                          Stop
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── InspectorPage ────────────────────────────────────────────────────────────

function methodClass(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":    return "method-get";
    case "POST":   return "method-post";
    case "PUT":    return "method-put";
    case "PATCH":  return "method-patch";
    case "DELETE": return "method-delete";
    default:       return "method-other";
  }
}

function statusClass(code: number | null, error: string | null): string {
  if (error)       return "status-err";
  if (code === null) return "status-pending";
  if (code < 300)  return "status-2xx";
  if (code < 400)  return "status-3xx";
  if (code < 500)  return "status-4xx";
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
    .filter(([, v]) => v !== undefined && !["host"].includes(String(v).toLowerCase()))
    .map(([k, v]) => `-H '${k}: ${Array.isArray(v) ? v.join(", ") : v}'`)
    .join(" \\\n  ");
  const body = req.requestBodyBase64 ? decodeBase64Body(req.requestBodyBase64) : "";
  const bodyArg = body ? ` \\\n  -d '${body.replace(/'/g, "'\\''")}' ` : "";
  return `curl -X ${req.method} '${url}' \\\n  ${headerArgs}${bodyArg}`;
}

function InspectorPage({
  api, tunnels, initialSubdomain, onBack,
}: {
  api: GatewayApi;
  tunnels: TunnelRecord[];
  initialSubdomain: string | null;
  onBack: () => void;
}) {
  const [subdomain, setSubdomain] = useState<string>(initialSubdomain ?? tunnels[0]?.subdomain ?? "");
  const [requests, setRequests] = useState<CapturedRequestSummary[]>([]);
  const [selected, setSelected] = useState<CapturedRequestDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<"req-headers" | "req-body" | "res-headers" | "res-body">("res-body");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [clearing, setClearing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchList = useCallback(() => {
    if (!subdomain) return;
    api.listInspectorRequests(subdomain)
      .then((data) => setRequests(data.requests))
      .catch(() => {/* silent — tunnel may not exist yet */});
  }, [api, subdomain]);

  useEffect(() => {
    fetchList();
    if (autoRefresh) {
      timerRef.current = setInterval(fetchList, 2000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchList, autoRefresh]);

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
      .then(() => { setRequests([]); setSelected(null); })
      .catch(() => {/* ignore */})
      .finally(() => setClearing(false));
  };

  const copyAsCurl = () => {
    if (!selected) return;
    const base = `${window.location.protocol}//${subdomain}.${window.location.hostname}`;
    const cmd = buildCurlCommand(selected, base);
    navigator.clipboard.writeText(cmd).catch(() => {/* ignore */});
  };

  const renderBody = () => {
    if (!selected) return null;
    if (activeTab === "req-headers" || activeTab === "res-headers") {
      const hdrs = activeTab === "req-headers" ? selected.requestHeaders : selected.responseHeaders;
      const entries = Object.entries(hdrs).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return <p className="inspector-no-body">No headers.</p>;
      return (
        <table className="inspector-headers-tbl">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{Array.isArray(v) ? v.join(", ") : String(v ?? "")}</td>
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
            Body truncated at 64 KB — full payload not stored.
          </div>
        )}
        <pre className="inspector-body-pre">{display}</pre>
      </>
    );
  };

  const selectedReqInfo = selected ? requests.find((r) => r.id === selected.id) : null;

  return (
    <div className="page">
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn-ghost" onClick={onBack}><i className="ti ti-arrow-left" /></button>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Traffic Inspector</span>
          {autoRefresh && <span className="inspector-live-badge"><span className="inspector-live-dot" />Live</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Subdomain picker */}
          {tunnels.length > 0 && (
            <select
              className="form-inp"
              style={{ height: 32, width: "auto", padding: "0 10px", fontSize: 12 }}
              value={subdomain}
              onChange={(e) => { setSubdomain(e.target.value); setRequests([]); setSelected(null); }}
            >
              {tunnels.map((t) => <option key={t.id} value={t.subdomain}>{t.subdomain}</option>)}
            </select>
          )}
          <button
            className={`btn-ghost`}
            title={autoRefresh ? "Pause auto-refresh" : "Resume auto-refresh"}
            onClick={() => setAutoRefresh((v) => !v)}
          >
            <i className={`ti ti-${autoRefresh ? "player-pause" : "player-play"}`} />
            {autoRefresh ? "Pause" : "Resume"}
          </button>
          <button className="btn-ghost" onClick={fetchList}><i className="ti ti-refresh" /> Refresh</button>
          <button className="btn-ghost" disabled={clearing || requests.length === 0} onClick={clearRequests}>
            <i className="ti ti-trash" /> Clear
          </button>
        </div>
      </div>

      {!subdomain ? (
        <div className="empty">
          <i className="ti ti-eye-off" />
          <div className="empty-title">No tunnel selected</div>
          <div className="empty-desc">Start a tunnel first, then open the inspector to see live traffic.</div>
        </div>
      ) : (
        <div className="inspector-layout">
          {/* ── Left: request list ── */}
          <div className="inspector-list-pane">
            <div className="inspector-list-head">
              <span className="inspector-subdomain">{subdomain}</span>
              <span style={{ fontSize: 11, color: "var(--text-3)" }}>{requests.length} req{requests.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="inspector-list-scroll">
              {requests.length === 0 ? (
                <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-3)" }}>
                  <i className="ti ti-wifi-off" style={{ fontSize: 28, display: "block", marginBottom: 10, opacity: 0.4 }} />
                  <p style={{ fontSize: 12 }}>Waiting for requests…</p>
                </div>
              ) : requests.map((r) => (
                <div
                  key={r.id}
                  className={`inspector-row${selected?.id === r.id ? " active" : ""}`}
                  onClick={() => selectRequest(r.id)}
                >
                  <div className="inspector-row-top">
                    <span className={`inspector-method ${methodClass(r.method)}`}>{r.method}</span>
                    <span className={`inspector-status ${statusClass(r.statusCode, r.error)}`}>
                      {r.error ? "ERR" : r.statusCode ?? "…"}
                    </span>
                    <span className="inspector-path">{r.path}</span>
                  </div>
                  <div className="inspector-row-meta">
                    <span>{new Date(r.capturedAt).toLocaleTimeString()}</span>
                    {r.durationMs !== null && (
                      <span className="inspector-duration">{r.durationMs} ms</span>
                    )}
                    {r.error && <span style={{ color: "var(--red)" }}>{r.error}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Right: detail pane ── */}
          <div className="inspector-detail-pane">
            {!selected ? (
              <div className="inspector-empty-detail">
                <i className="ti ti-click" />
                <p>Select a request to inspect</p>
              </div>
            ) : (
              <>
                <div className="inspector-detail-head">
                  <div className="inspector-detail-title">
                    <span className={`inspector-method ${methodClass(selected.method)}`}>{selected.method}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.path}</span>
                    {selectedReqInfo && (
                      <span className={`inspector-status ${statusClass(selected.statusCode, selected.error)}`}>
                        {selected.error ? "ERR" : selected.statusCode ?? "…"}
                      </span>
                    )}
                    {selected.durationMs !== null && (
                      <span style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 4 }}>{selected.durationMs} ms</span>
                    )}
                  </div>
                  <div className="inspector-detail-actions">
                    {loadingDetail && <i className="ti ti-loader-2 spin" style={{ fontSize: 16, color: "var(--text-3)" }} />}
                    <button className="btn-ghost" onClick={copyAsCurl} title="Copy as cURL">
                      <i className="ti ti-terminal" /> cURL
                    </button>
                  </div>
                </div>

                <div className="inspector-tabs">
                  {(["res-body", "res-headers", "req-body", "req-headers"] as const).map((tab) => (
                    <button
                      key={tab}
                      className={`inspector-tab${activeTab === tab ? " active" : ""}`}
                      onClick={() => setActiveTab(tab)}
                    >
                      {tab === "res-body" ? "Response Body"
                        : tab === "res-headers" ? "Response Headers"
                        : tab === "req-body" ? "Request Body"
                        : "Request Headers"}
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

// ─── DevicesPage ──────────────────────────────────────────────────────────────

function DevicesPage({ user, onCopy }: { user: UserInfo | null; onCopy: (text: string) => void }) {
  const wsUrl = getWsGatewayUrl();
  const installCmd = "npm install -g portivox";
  const openCmd = `portivox open 3000 --gateway ${wsUrl}`;
  const openWithKeyCmd = `portivox open 3000 --gateway ${wsUrl} --key tk_YOUR_API_KEY`;

  return (
    <div className="page">
      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-device-laptop" /> Connect a device</div>
        </div>
        <div style={{ padding: "16px 22px" }}>
          <div className="ai-insight">
            <div className="ai-badge"><i className="ti ti-info-circle" /></div>
            <div style={{ flex: 1 }}>
              <div className="ai-insight-label">How it works</div>
              <div className="ai-insight-text">
                Install the Portivox CLI on any device and run{" "}
                <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>portivox open &lt;port&gt;</code>.
                No registration needed — connect from anywhere.
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-terminal-2" /> Quick start</div>
        </div>
        <div style={{ padding: "18px 22px", display: "grid", gap: 20 }}>
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>
              1 — Install the CLI
            </p>
            <div className="code-block">
              <code>{installCmd}</code>
              <div className="icon-btn" style={{ color: "#b4a9ff" }} onClick={() => onCopy(installCmd)} title="Copy">
                <i className="ti ti-copy" />
              </div>
            </div>
          </div>
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>
              2 — Open a tunnel (connects to this gateway)
            </p>
            <div className="code-block">
              <code>{openCmd}</code>
              <div className="icon-btn" style={{ color: "#b4a9ff" }} onClick={() => onCopy(openCmd)} title="Copy">
                <i className="ti ti-copy" />
              </div>
            </div>
          </div>
          {user && user.email !== "local@anonymous" && (
            <div>
              <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 4 }}>
                3 — For CI/CD or automation, use an API key
              </p>
              <p style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>
                Generate a key in the <strong>API Keys</strong> section, then replace{" "}
                <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>tk_YOUR_API_KEY</code>:
              </p>
              <div className="code-block">
                <code>{openWithKeyCmd}</code>
                <div className="icon-btn" style={{ color: "#b4a9ff" }} onClick={() => onCopy(openWithKeyCmd)} title="Copy">
                  <i className="ti ti-copy" />
                </div>
              </div>
            </div>
          )}
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>
              More options
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[
                { cmd: `portivox open 3000 --subdomain myapp --gateway ${wsUrl}`, label: "Custom subdomain" },
                { cmd: `portivox open 5432 --type tcp --gateway ${wsUrl}`, label: "TCP tunnel (database)" },
                { cmd: `portivox open 3000 --no-ip-protection --gateway ${wsUrl}`, label: "Disable IP protection" },
                { cmd: `portivox list --gateway ${wsUrl}`, label: "List active tunnels" },
              ].map(({ cmd, label }) => (
                <div key={label} style={{ background: "var(--bg-secondary)", borderRadius: "var(--r-md)", padding: "12px 14px", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-2)", marginBottom: 6 }}>{label}</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <code style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)", wordBreak: "break-all" }}>
                      {cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd}
                    </code>
                    <div className="icon-btn" style={{ flexShrink: 0, color: "var(--text-3)" }} onClick={() => onCopy(cmd)} title="Copy">
                      <i className="ti ti-copy" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── AiPage ───────────────────────────────────────────────────────────────────

function AiPage() {
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const sendMessage = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      { role: "user", text },
      {
        role: "assistant",
        text: `AI assistant is coming soon. In the meantime, check the Portivox documentation or use the CLI help command: portivox --help`,
      },
    ]);
    setChatInput("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [chatInput]);

  return (
    <div className="page">
      <div className="ai-page-banner">
        <div className="ai-page-text">
          <div className="ai-page-title">
            AI Assistant
            <span style={{ fontSize: 11, fontWeight: 500, background: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.8)", padding: "2px 9px", borderRadius: 20, marginLeft: 10 }}>
              Coming soon
            </span>
          </div>
          <div className="ai-page-sub">
            Natural language interface for your tunnels. Ask anything — setup help,
            diagnostics, security review, or CLI commands.
          </div>
        </div>
        <i className="ti ti-robot ai-page-icon" />
      </div>

      {messages.length > 0 && (
        <div className="section">
          {messages.map((msg, i) => (
            <div key={i} style={{
              padding: "14px 22px",
              display: "flex", gap: 12, alignItems: "flex-start",
              borderBottom: "1px solid var(--border)",
              background: msg.role === "assistant" ? "var(--bg-secondary)" : undefined,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                background: msg.role === "user" ? "var(--accent)" : "var(--accent-bg)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, color: msg.role === "user" ? "#fff" : "var(--accent)",
              }}>
                <i className={`ti ${msg.role === "user" ? "ti-user" : "ti-robot"}`} />
              </div>
              <div style={{ fontSize: 13, color: "var(--text-1)", lineHeight: 1.65, paddingTop: 4 }}>
                {msg.text}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-bolt" /> Quick actions</div>
        </div>
        <div className="ai-grid">
          {AI_QUICK_ACTIONS.map((card) => (
            <button key={card.title} className="ai-card" onClick={() => setChatInput(card.prompt)}>
              <div className="ai-card-icon"><i className={`ti ${card.icon}`} /></div>
              <div>
                <div className="ai-card-title">{card.title}</div>
                <div className="ai-card-desc">{card.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <div style={{ padding: "14px 22px", display: "flex", gap: 10 }}>
          <input
            ref={inputRef}
            className="form-inp"
            style={{ flex: 1 }}
            placeholder="Ask anything about your tunnels, CLI commands, or setup…"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          />
          <button className="btn-primary" onClick={sendMessage} disabled={!chatInput.trim()}>
            <i className="ti ti-send" /> Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── UsagePage ────────────────────────────────────────────────────────────────

function UsagePage({ api, tunnelCount }: { api: GatewayApi; tunnelCount: number }) {
  const [gwStatus, setGwStatus] = useState<GatewayStatus | null>(null);
  const [auditItems, setAuditItems] = useState<AuditItem[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(true);

  useEffect(() => {
    setLoadingStatus(true);
    const pubApi = new GatewayApi(DEFAULT_GATEWAY, {});
    const p1 = pubApi.getReadyz().then(setGwStatus).catch(() => {});
    const p2 = api.getAudit(50).then(setAuditItems).catch(() => {});
    void Promise.all([p1, p2]).finally(() => setLoadingStatus(false));
  }, [api]);

  const activeTunnels = gwStatus?.activeTunnels ?? tunnelCount;

  return (
    <div className="page">
      <div className="metrics" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-plug-connected" /></div>
            Active tunnels
          </div>
          <div className="metric-val">{loadingStatus ? "…" : activeTunnels}</div>
          <div className="metric-sub">
            {activeTunnels > 0 ? <span className="up">↑ Running</span> : "None active"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-server" /></div>
            Gateway
          </div>
          <div className="metric-val" style={{ fontSize: 15, paddingTop: 5, fontWeight: 600 }}>
            {loadingStatus ? "…" : gwStatus?.ready ? "Ready" : "Unknown"}
          </div>
          <div className={`metric-sub ${gwStatus?.ready ? "up" : ""}`}>
            {gwStatus?.maintenanceMode
              ? "⚠ Maintenance mode"
              : gwStatus?.draining
                ? "⚠ Draining"
                : gwStatus?.ready
                  ? "↑ Healthy"
                  : "Status unknown"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-list-check" /></div>
            Audit events
          </div>
          <div className="metric-val">{loadingStatus ? "…" : auditItems.length}</div>
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
              {auditItems.map((item, i) => (
                <tr key={item.id || i}>
                  <td>
                    <span className="chip chip-purple" style={{ fontSize: 10 }}>{item.action}</span>
                  </td>
                  <td style={{ color: "var(--text-2)", fontSize: 12 }}>
                    {item.resource}
                    {item.resourceId ? (
                      <span style={{ color: "var(--text-3)", marginLeft: 4 }}>
                        / {item.resourceId.slice(0, 8)}
                      </span>
                    ) : null}
                  </td>
                  <td style={{ color: "var(--text-3)", fontSize: 12 }}>
                    {item.userId ? item.userId.slice(0, 8) + "…" : "—"}
                  </td>
                  <td style={{ color: "var(--text-3)", fontSize: 12 }}>
                    {new Date(item.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── ApiKeysPage ──────────────────────────────────────────────────────────────

function ApiKeysPage({
  apiKeys, loading, createdKeyToken, onDismissToken, onNewKey, onRevokeKey, onCopy, onRefresh,
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
  const activeKeys = apiKeys.filter((k) => !k.revoked);

  return (
    <div className="page">
      {createdKeyToken && (
        <div className="ai-insight" style={{ borderColor: "rgba(0,184,148,0.2)", background: "var(--green-bg)", marginBottom: 16 }}>
          <div className="ai-badge" style={{ background: "var(--green)" }}>
            <i className="ti ti-check" />
          </div>
          <div style={{ flex: 1 }}>
            <div className="ai-insight-label" style={{ color: "var(--green)" }}>Key generated — copy now</div>
            <div className="ai-insight-text" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
              <span className="url-pill" style={{ userSelect: "all", cursor: "text" }}>{createdKeyToken}</span>
              <span style={{ fontSize: 12, color: "var(--text-2)" }}>This token is shown only once.</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div className="icon-btn" onClick={() => onCopy(createdKeyToken)} title="Copy token">
              <i className="ti ti-copy" />
            </div>
            <i className="ti ti-x ai-dismiss" onClick={onDismissToken} />
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
            <button className="btn-primary" onClick={onNewKey}>
              <i className="ti ti-plus" /> Generate key
            </button>
          </div>
        </div>

        {activeKeys.length === 0 ? (
          <div className="empty">
            <i className="ti ti-key" />
            <div className="empty-title">No API keys yet</div>
            <div className="empty-desc">
              Generate a key to automate tunnel management, integrate with CI/CD pipelines,
              or build on top of the Portivox API.
            </div>
            <button className="btn-primary" style={{ margin: "0 auto" }} onClick={onNewKey}>
              <i className="ti ti-plus" /> Generate your first key
            </button>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Scopes</th>
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
                      {key.scopes.map((s) => (
                        <span key={s} className="chip chip-purple" style={{ fontSize: 10 }}>{s}</span>
                      ))}
                    </div>
                  </td>
                  <td style={{ color: "var(--text-3)", fontSize: 12 }}>
                    {new Date(key.createdAt).toLocaleDateString()}
                  </td>
                  <td>
                    <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                      <button className="stop-btn" disabled={loading}
                        onClick={() => onRevokeKey(key.id, key.name)}>
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── OrgPage ──────────────────────────────────────────────────────────────────

function OrgPage({ user }: { user: UserInfo | null }) {
  const [showInviteNote, setShowInviteNote] = useState(false);

  return (
    <div className="page">
      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-building" /> Organisation</div>
        </div>
        <div style={{ padding: "20px 22px", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700, color: "var(--accent)", flexShrink: 0 }}>
            {user?.initials?.[0] ?? "P"}
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-1)" }}>My Workspace</div>
            <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 3 }}>
              Self-hosted instance · {user ? "1 member" : "—"}
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-users" /> Members</div>
          <button className="btn-ghost" onClick={() => setShowInviteNote((v) => !v)}>
            <i className="ti ti-user-plus" /> Invite
          </button>
        </div>

        {showInviteNote && (
          <div style={{ padding: "0 22px 16px" }}>
            <div className="ai-insight">
              <div className="ai-badge"><i className="ti ti-info-circle" /></div>
              <div style={{ flex: 1 }}>
                <div className="ai-insight-label">Team management</div>
                <div className="ai-insight-text">
                  In self-hosted mode, additional users can sign up directly using the <strong>Create Account</strong> form.
                  Full invitation flows, role management, and SSO are planned for a future release.
                </div>
              </div>
              <i className="ti ti-x ai-dismiss" onClick={() => setShowInviteNote(false)} />
            </div>
          </div>
        )}

        {user ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>Member</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div className="avatar" style={{ width: 28, height: 28, fontSize: 10 }}>{user.initials}</div>
                    <strong>{user.name}</strong>
                  </div>
                </td>
                <td style={{ color: "var(--text-2)", fontSize: "12.5px" }}>{user.email}</td>
                <td>
                  <span className="chip chip-purple">
                    {user.role === "owner" ? "Owner" : user.role === "admin" ? "Admin" : "Member"}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <div className="empty">
            <i className="ti ti-users" />
            <div className="empty-title">No members</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SettingsPage ─────────────────────────────────────────────────────────────

function SettingsPage({
  user, isAnonymous, api, showToast, onLogout,
}: {
  user: UserInfo | null;
  isAnonymous: boolean;
  api: GatewayApi;
  showToast: (msg: string, type?: Toast["type"]) => void;
  onLogout: () => void;
}) {
  const [displayName, setDisplayName] = useState(user?.name ?? "");
  const [curPass, setCurPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [passLoading, setPassLoading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const saveDisplayName = () => {
    // Display name is stored locally (no backend profile endpoint yet)
    try {
      const raw = localStorage.getItem("ptx-session");
      if (raw) {
        const sess = JSON.parse(raw) as Record<string, unknown>;
        sess.name = displayName;
        localStorage.setItem("ptx-session", JSON.stringify(sess));
      }
    } catch { /* ignore */ }
    showToast("Display name saved locally", "green");
  };

  const doChangePassword = useCallback(() => {
    if (!curPass || !newPass || !confirmPass) {
      showToast("Please fill in all password fields", "red");
      return;
    }
    if (newPass !== confirmPass) {
      showToast("New passwords do not match", "red");
      return;
    }
    if (newPass.length < 8) {
      showToast("New password must be at least 8 characters", "red");
      return;
    }
    setPassLoading(true);
    api
      .changePassword(curPass, newPass)
      .then(() => {
        showToast("Password changed successfully!", "green");
        setCurPass("");
        setNewPass("");
        setConfirmPass("");
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to change password", "red");
      })
      .finally(() => setPassLoading(false));
  }, [api, curPass, newPass, confirmPass, showToast]);

  return (
    <div className="page">
      {/* Profile */}
      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-user-circle" /> Profile</div>
        </div>
        <div className="form-body">
          <div className="form-field">
            <label className="form-lbl">Display name</label>
            <input type="text" className="form-inp" value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveDisplayName()} />
            <p style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 5 }}>
              Stored locally in your browser.
            </p>
          </div>
          <div className="form-field">
            <label className="form-lbl">Email address</label>
            <input type="email" className="form-inp" value={user?.email ?? ""} disabled />
          </div>
          <button className="btn-save" onClick={saveDisplayName}>
            <i className="ti ti-check" /> Save name
          </button>
        </div>
      </div>

      {/* Password change — only for JWT users */}
      {!isAnonymous ? (
        <div className="section">
          <div className="section-head">
            <div className="section-title"><i className="ti ti-lock" /> Change password</div>
          </div>
          <div className="form-body">
            <div className="form-field">
              <label className="form-lbl">Current password</label>
              <input type="password" className="form-inp" value={curPass}
                onChange={(e) => setCurPass(e.target.value)} placeholder="••••••••" />
            </div>
            <div className="form-field">
              <label className="form-lbl">New password</label>
              <input type="password" className="form-inp" value={newPass}
                onChange={(e) => setNewPass(e.target.value)} placeholder="Min. 8 characters" />
            </div>
            <div className="form-field">
              <label className="form-lbl">Confirm new password</label>
              <input type="password" className="form-inp" value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)} placeholder="Repeat new password"
                onKeyDown={(e) => e.key === "Enter" && doChangePassword()} />
            </div>
            <button className="btn-save" disabled={passLoading} onClick={doChangePassword}>
              {passLoading
                ? <><i className="ti ti-loader-2 spin" /> Saving…</>
                : <><i className="ti ti-check" /> Change password</>}
            </button>
          </div>
        </div>
      ) : (
        <div className="section">
          <div style={{ padding: "18px 22px" }}>
            <div className="ai-insight">
              <div className="ai-badge"><i className="ti ti-info-circle" /></div>
              <div style={{ flex: 1 }}>
                <div className="ai-insight-label">Auth disabled</div>
                <div className="ai-insight-text">
                  This gateway is running with <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>AUTH_REQUIRED=false</code>.
                  Password management is not available in anonymous mode. Set <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>AUTH_REQUIRED=true</code> and restart to enable user accounts.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Danger zone */}
      <div className="section" style={{ borderColor: "rgba(225,112,85,0.25)" }}>
        <div className="section-head">
          <div className="section-title" style={{ color: "var(--red)" }}>
            <i className="ti ti-alert-triangle" style={{ color: "var(--red)" }} /> Danger zone
          </div>
        </div>
        <div style={{ padding: "18px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: "13.5px", fontWeight: 500 }}>Sign out</div>
            <div style={{ fontSize: "12.5px", color: "var(--text-2)", marginTop: 3 }}>
              Sign out of this session. Your tunnels will remain active.
            </div>
          </div>
          <button className="btn-danger" onClick={onLogout}>
            <i className="ti ti-logout" /> Sign out
          </button>
        </div>
        {!isAnonymous && (
          <div style={{ padding: "0 22px 18px", borderTop: "1px solid var(--border)", paddingTop: 18, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div>
              <div style={{ fontSize: "13.5px", fontWeight: 500 }}>Delete account</div>
              <div style={{ fontSize: "12.5px", color: "var(--text-2)", marginTop: 3 }}>
                Remove your user account from this self-hosted instance.
              </div>
            </div>
            <button className="btn-danger" style={{ opacity: 0.8 }} onClick={() => setShowDeleteConfirm(true)}>
              Delete account
            </button>
          </div>
        )}
      </div>

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete account?"
          message={`Account deletion requires direct database access on a self-hosted instance. Connect to the PostgreSQL database and run: DELETE FROM "User" WHERE email = 'your@email.com'; or use docker compose down -v to wipe all data.`}
          confirmLabel="I understand"
          onConfirm={() => setShowDeleteConfirm(false)}
          onClose={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}

// ─── BillingPage ──────────────────────────────────────────────────────────────

function BillingPage({ showToast }: { showToast: (msg: string, type?: Toast["type"]) => void }) {
  const [invoiceOrg, setInvoiceOrg] = useState(
    () => localStorage.getItem("ptx-billing-org") ?? ""
  );
  const [taxId, setTaxId] = useState(
    () => localStorage.getItem("ptx-billing-taxid") ?? ""
  );
  const [invoiceEmail, setInvoiceEmail] = useState(
    () => localStorage.getItem("ptx-billing-email") ?? ""
  );

  const saveDetails = () => {
    localStorage.setItem("ptx-billing-org", invoiceOrg);
    localStorage.setItem("ptx-billing-taxid", taxId);
    localStorage.setItem("ptx-billing-email", invoiceEmail);
    showToast("Invoice details saved to browser storage", "green");
  };

  return (
    <div className="page">
      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-credit-card" /> Current plan</div>
        </div>
        <div className="billing-plan-row">
          <div>
            <div className="plan-name">Self-hosted plan</div>
            <div className="plan-desc">Your own infrastructure · no payment required</div>
          </div>
          <span className="plan-chip">Self-hosted</span>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-file-invoice" /> Invoices</div>
        </div>
        <div className="empty">
          <i className="ti ti-receipt-off" />
          <div className="empty-title">No invoices</div>
          <div className="empty-desc">Your self-hosted instance has no billing requirements.</div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-building" /> Invoice details</div>
        </div>
        <div className="form-body">
          <div className="ai-insight" style={{ marginBottom: 16 }}>
            <div className="ai-badge"><i className="ti ti-info-circle" /></div>
            <div style={{ flex: 1 }}>
              <div className="ai-insight-label">Stored locally</div>
              <div className="ai-insight-text">
                Invoice details are saved in your browser's local storage for reference. No data is sent to any server.
              </div>
            </div>
          </div>
          <div className="form-field">
            <label className="form-lbl">Name on invoice</label>
            <input type="text" className="form-inp" placeholder="Organisation name"
              value={invoiceOrg} onChange={(e) => setInvoiceOrg(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-lbl">Tax ID</label>
            <input type="text" className="form-inp" placeholder="e.g. VAT BE0123456789"
              value={taxId} onChange={(e) => setTaxId(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-lbl">Invoice email</label>
            <input type="email" className="form-inp" placeholder="billing@company.com"
              value={invoiceEmail} onChange={(e) => setInvoiceEmail(e.target.value)} />
          </div>
          <button className="btn-save" onClick={saveDetails}>
            <i className="ti ti-check" /> Save details
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Admin helpers ───────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (isNaN(s)) return "—";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function actionBadge(action: string): { cls: string; icon: string } {
  if (action.includes("created") || action.includes("registered")) return { cls: "create", icon: "ti-plus" };
  if (action.includes("deleted") || action.includes("revoked")) return { cls: "delete", icon: "ti-trash" };
  if (action.includes("login") || action.includes("auth") || action.includes("password")) return { cls: "auth", icon: "ti-lock" };
  if (action.includes("admin") || action.includes("state") || action.includes("maintenance") || action.includes("drain")) return { cls: "admin", icon: "ti-shield" };
  return { cls: "other", icon: "ti-activity" };
}

// ─── AdminOverviewPage ────────────────────────────────────────────────────────

function AdminOverviewPage({
  api, showToast,
}: {
  api: GatewayApi;
  showToast: (msg: string, type?: Toast["type"]) => void;
}) {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [chunkDiag, setChunkDiag] = useState<{ chunkFramesReceived: number; chunkStreamsReassembled: number; chunkIncompleteTimeouts: number; activeChunkAssemblies: number } | null>(null);
  const [recentAudit, setRecentAudit] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.getReadyz(),
      api.getChunkDiagnostics(),
      api.getAudit(10),
    ]).then(([s, c, a]) => {
      setStatus(s);
      setChunkDiag(c as typeof chunkDiag);
      setRecentAudit(a);
    }).catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : "Failed to load admin data", "red");
    }).finally(() => setLoading(false));
  }, [api, showToast]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  function toggleMode(field: "maintenanceMode" | "draining", val: boolean) {
    setToggling(true);
    api.setAdminState({ [field]: val }).then((s) => {
      setStatus(s);
      showToast(
        field === "maintenanceMode"
          ? (val ? "Maintenance mode enabled" : "Maintenance mode disabled")
          : (val ? "Draining enabled" : "Draining disabled"),
        "green"
      );
    }).catch((e: unknown) => {
      showToast(e instanceof Error ? e.message : "Failed to update state", "red");
    }).finally(() => setToggling(false));
  }

  const isHealthy = status?.ready && !status?.draining && !status?.maintenanceMode;

  return (
    <div className="page-body">
      {/* Hero */}
      <div className="admin-hero">
        <div className="admin-hero-left">
          <div className="admin-hero-title">
            <i className="ti ti-shield-check" />
            Administration
            <span className="admin-hero-badge">Admin Panel</span>
          </div>
          <div className="admin-hero-sub">System overview — live data, refreshed every 30 seconds</div>
        </div>
        <div className="admin-hero-right">
          <button className="btn-ghost" style={{ color: "#fff", borderColor: "rgba(255,255,255,0.2)" }}
            onClick={refresh} disabled={loading}>
            <i className={`ti ti-refresh${loading ? " spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-card-head">
            <div className="kpi-icon purple"><i className="ti ti-topology-star-3" /></div>
            {status && (
              <div className={`status-live`} style={{ color: status.ready ? "var(--green)" : "var(--red)" }}>
                <div className={`status-pulse ${status.ready ? "" : "red"}`} />
                {status.ready ? "Online" : "Offline"}
              </div>
            )}
          </div>
          <div className="kpi-val">{loading ? "…" : (status?.activeTunnels ?? 0)}</div>
          <div className="kpi-label">Active Tunnels</div>
          <div className="kpi-delta neutral">Connected right now</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-head">
            <div className="kpi-icon green"><i className="ti ti-server" /></div>
          </div>
          <div className="kpi-val" style={{ fontSize: 18, paddingTop: 4 }}>
            {loading ? "…" : isHealthy ? "Healthy" : status?.maintenanceMode ? "Maintenance" : status?.draining ? "Draining" : "Unknown"}
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
          <div className="kpi-val">{loading ? "…" : (chunkDiag?.chunkFramesReceived ?? 0)}</div>
          <div className="kpi-label">Chunk Frames</div>
          <div className="kpi-delta neutral">
            {chunkDiag ? `${chunkDiag.chunkStreamsReassembled} reassembled` : "Loading…"}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-head">
            <div className={`kpi-icon ${(chunkDiag?.chunkIncompleteTimeouts ?? 0) > 0 ? "red" : "green"}`}>
              <i className="ti ti-clock-exclamation" />
            </div>
          </div>
          <div className="kpi-val">{loading ? "…" : (chunkDiag?.chunkIncompleteTimeouts ?? 0)}</div>
          <div className="kpi-label">Incomplete Timeouts</div>
          <div className={`kpi-delta ${(chunkDiag?.chunkIncompleteTimeouts ?? 0) > 0 ? "down" : "up"}`}>
            <i className={`ti ti-${(chunkDiag?.chunkIncompleteTimeouts ?? 0) > 0 ? "alert-triangle" : "circle-check"}`} />
            {(chunkDiag?.chunkIncompleteTimeouts ?? 0) > 0 ? "Needs attention" : "Within normal range"}
          </div>
        </div>
      </div>

      {/* Controls */}
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
              <input type="checkbox" checked={status?.maintenanceMode ?? false} disabled={toggling || loading}
                onChange={(e) => toggleMode("maintenanceMode", e.target.checked)} />
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
              <input type="checkbox" checked={status?.draining ?? false} disabled={toggling || loading}
                onChange={(e) => toggleMode("draining", e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </label>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-activity" /> Recent Activity</div>
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>Last 10 events</div>
        </div>
        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-3)" }}>
            <i className="ti ti-loader-2 spin" style={{ fontSize: 22, display: "block", marginBottom: 8 }} />
            Loading…
          </div>
        ) : recentAudit.length === 0 ? (
          <div className="empty">
            <i className="ti ti-clipboard-off" />
            <div className="empty-title">No audit events yet</div>
            <div className="empty-desc">Events will appear here as users interact with the system.</div>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Action</th><th>Resource</th><th>User</th><th>When</th>
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
                      {item.resource}{item.resourceId ? <><br /><code style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{item.resourceId.slice(0, 12)}…</code></> : null}
                    </td>
                    <td>
                      <span className="tunnel-user-chip">
                        <i className="ti ti-user" />
                        {item.userId ? item.userId.slice(0, 8) + "…" : "system"}
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
        )}
      </div>
    </div>
  );
}

// ─── AdminAuditPage ───────────────────────────────────────────────────────────

function AdminAuditPage({ api, showToast }: { api: GatewayApi; showToast: (msg: string, type?: Toast["type"]) => void }) {
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
    }).then((r) => {
      setItems(r.items);
      setNextCursor(r.nextCursor);
      if (pushCursor) setCursorStack((s) => [...s, pushCursor]);
    }).catch((e: unknown) => {
      showToast(e instanceof Error ? e.message : "Failed to load audit log", "red");
    }).finally(() => setLoading(false));
  }, [api, filterAction, filterResource, filterFrom, filterTo, filterLimit, showToast]);

  useEffect(() => {
    setCursorStack([]);
    setNextCursor(undefined);
    load(undefined);
  }, [load]);

  function exportCsv() {
    const header = "id,userId,action,resource,resourceId,createdAt,metadata";
    const rows = items.map((i) => [
      i.id, i.userId ?? "", i.action, i.resource, i.resourceId ?? "",
      i.createdAt, JSON.stringify(i.metadata ?? {}).replace(/,/g, ";"),
    ].map((v) => `"${v}"`).join(","));
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `audit-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page-body">
      <div className="admin-hero">
        <div className="admin-hero-left">
          <div className="admin-hero-title"><i className="ti ti-clipboard-list" />Audit Log<span className="admin-hero-badge">Admin</span></div>
          <div className="admin-hero-sub">Full event history — every action logged with user, resource and timestamp</div>
        </div>
        <div className="admin-hero-right">
          <button className="btn-ghost" style={{ color: "#fff", borderColor: "rgba(255,255,255,0.2)" }}
            onClick={exportCsv} disabled={items.length === 0}>
            <i className="ti ti-download" /> Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="audit-filter-bar">
        <label>Action</label>
        <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)}>
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
        <select value={filterResource} onChange={(e) => setFilterResource(e.target.value)}>
          <option value="">All resources</option>
          <option value="tunnel">tunnel</option>
          <option value="api_key">api_key</option>
          <option value="user">user</option>
          <option value="tunnel_session">tunnel_session</option>
        </select>

        <label>From</label>
        <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} style={{ width: 140 }} />

        <label>To</label>
        <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} style={{ width: 140 }} />

        <label>Limit</label>
        <select value={filterLimit} onChange={(e) => setFilterLimit(Number(e.target.value))}>
          {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>

        <button className="btn-ghost" style={{ marginLeft: "auto" }} onClick={() => {
          setFilterAction(""); setFilterResource(""); setFilterFrom(""); setFilterTo(""); setFilterLimit(50);
        }}>
          <i className="ti ti-x" /> Clear
        </button>
      </div>

      {/* Table */}
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
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="empty">
            <i className="ti ti-clipboard-off" />
            <div className="empty-title">No events match your filters</div>
            <div className="empty-desc">Try clearing the filters to see all audit events.</div>
          </div>
        ) : (
          <>
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
                      <td style={{ color: "var(--text-2)", fontSize: 12 }}>{item.resource}</td>
                      <td>
                        {item.resourceId
                          ? <code style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-3)" }}>{item.resourceId.slice(0, 16)}{item.resourceId.length > 16 ? "…" : ""}</code>
                          : <span style={{ color: "var(--text-3)", fontSize: 11 }}>—</span>}
                      </td>
                      <td>
                        {item.userId
                          ? <span className="tunnel-user-chip"><i className="ti ti-user" />{item.userId.slice(0, 10)}{item.userId.length > 10 ? "…" : ""}</span>
                          : <span style={{ color: "var(--text-3)", fontSize: 11 }}>system</span>}
                      </td>
                      <td style={{ maxWidth: 200 }}>
                        {item.metadata && Object.keys(item.metadata).length > 0
                          ? (() => { const metaStr = JSON.stringify(item.metadata); return (
                            <code style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", wordBreak: "break-all" }}>
                              {metaStr.slice(0, 60)}{metaStr.length > 60 ? "…" : ""}
                            </code>
                          ); })()
                          : <span style={{ color: "var(--text-3)", fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ color: "var(--text-3)", fontSize: 12, whiteSpace: "nowrap" }}
                        title={new Date(item.createdAt).toLocaleString()}>
                        {timeAgo(item.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
              <button className="btn-ghost" disabled={cursorStack.length === 0 || loading}
                onClick={() => {
                  const stack = [...cursorStack];
                  stack.pop();
                  const prev = stack[stack.length - 1];
                  setCursorStack(stack);
                  load(prev);
                }}>
                <i className="ti ti-chevron-left" /> Prev
              </button>
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                Page {cursorStack.length + 1}
              </span>
              <button className="btn-ghost" disabled={!nextCursor || loading}
                onClick={() => { if (nextCursor) load(nextCursor, nextCursor); }}>
                Next <i className="ti ti-chevron-right" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── AdminGatewayPage ─────────────────────────────────────────────────────────

function AdminGatewayPage({ api, tunnels: allTunnels, showToast, onConfirm }: {
  api: GatewayApi;
  tunnels: TunnelRecord[];
  showToast: (msg: string, type?: Toast["type"]) => void;
  onConfirm: (state: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void;
}) {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [chunkDiag, setChunkDiag] = useState<{ chunkFramesReceived: number; chunkStreamsReassembled: number; chunkIncompleteTimeouts: number; activeChunkAssemblies?: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([api.getReadyz(), api.getChunkDiagnostics()])
      .then(([s, c]) => { setStatus(s); setChunkDiag(c as typeof chunkDiag); })
      .catch((e: unknown) => showToast(e instanceof Error ? e.message : "Load failed", "red"))
      .finally(() => setLoading(false));
  }, [api, showToast]);

  useEffect(() => { refresh(); }, [refresh]);

  function toggleMode(field: "maintenanceMode" | "draining", val: boolean, confirmMsg: string) {
    if (val) {
      onConfirm({
        title: `Enable ${field === "maintenanceMode" ? "Maintenance Mode" : "Draining"}?`,
        message: confirmMsg,
        confirmLabel: "Confirm",
        danger: true,
        onConfirm: () => doToggle(field, val),
      });
    } else {
      doToggle(field, val);
    }
  }

  function doToggle(field: "maintenanceMode" | "draining", val: boolean) {
    setToggling(true);
    api.setAdminState({ [field]: val })
      .then((s) => { setStatus(s); showToast("Gateway state updated", "green"); })
      .catch((e: unknown) => showToast(e instanceof Error ? e.message : "Update failed", "red"))
      .finally(() => setToggling(false));
  }

  const isHealthy = status?.ready && !status?.draining && !status?.maintenanceMode;

  return (
    <div className="page-body">
      <div className="admin-hero">
        <div className="admin-hero-left">
          <div className="admin-hero-title"><i className="ti ti-server-cog" />Gateway Control<span className="admin-hero-badge">Admin</span></div>
          <div className="admin-hero-sub">Live status, tunnel management and runtime controls</div>
        </div>
        <div className="admin-hero-right">
          <button className="btn-ghost" style={{ color: "#fff", borderColor: "rgba(255,255,255,0.2)" }}
            onClick={refresh} disabled={loading}>
            <i className={`ti ti-refresh${loading ? " spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {/* Status Cards */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(2,1fr)" }}>
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
          <div className="kpi-val">{status?.activeTunnels ?? "…"}</div>
          <div className="kpi-label">Active Tunnels</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-head">
            <div className="kpi-icon purple"><i className="ti ti-stack-2" /></div>
          </div>
          <div className="kpi-val" style={{ fontSize: 20, paddingTop: 4 }}>
            {chunkDiag ? `${chunkDiag.chunkFramesReceived}` : "…"}
          </div>
          <div className="kpi-label">Chunk Frames Received</div>
          <div className="kpi-delta neutral">
            {chunkDiag ? `${chunkDiag.chunkStreamsReassembled} reassembled · ${chunkDiag.chunkIncompleteTimeouts} timeouts` : ""}
          </div>
        </div>
      </div>

      {/* Toggle Controls */}
      <div className="section" style={{ marginBottom: 16 }}>
        <div className="section-head">
          <div className="section-title"><i className="ti ti-settings-2" /> Runtime Controls</div>
        </div>
        <div style={{ padding: "14px 18px", display: "grid", gap: 10 }}>
          <label className="toggle-row">
            <div className="toggle-row-info">
              <div className="toggle-row-title">
                {status?.maintenanceMode && <span style={{ color: "var(--red)", marginRight: 6, fontSize: 11, fontWeight: 700 }}>● ACTIVE</span>}
                Maintenance Mode
              </div>
              <div className="toggle-row-desc">Rejects all new requests with HTTP 503. Use before upgrades.</div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={status?.maintenanceMode ?? false} disabled={toggling || loading}
                onChange={(e) => toggleMode("maintenanceMode", e.target.checked,
                  "This will reject all new tunnel connections and return 503 to clients. Existing sessions are preserved.")} />
              <span className="toggle-track" />
            </label>
          </label>

          <label className="toggle-row">
            <div className="toggle-row-info">
              <div className="toggle-row-title">
                {status?.draining && <span style={{ color: "var(--yellow)", marginRight: 6, fontSize: 11, fontWeight: 700 }}>● ACTIVE</span>}
                Draining Mode
              </div>
              <div className="toggle-row-desc">Stops accepting new WebSocket clients. Allows graceful node shutdown.</div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={status?.draining ?? false} disabled={toggling || loading}
                onChange={(e) => toggleMode("draining", e.target.checked,
                  "This will stop accepting new WebSocket tunnel connections. Enable before a rolling restart or node removal.")} />
              <span className="toggle-track" />
            </label>
          </label>
        </div>
      </div>

      {/* All Tunnels */}
      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-topology-star-3" /> All Active Tunnels ({allTunnels.length})</div>
        </div>
        {allTunnels.length === 0 ? (
          <div className="empty">
            <i className="ti ti-topology-star-3" />
            <div className="empty-title">No active tunnels</div>
            <div className="empty-desc">Tunnels appear here as users connect via the CLI.</div>
          </div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Subdomain</th><th>Tunnel ID</th><th>Created</th></tr></thead>
            <tbody>
              {allTunnels.map((t) => (
                <tr key={t.id}>
                  <td>
                    <a href={`//${t.subdomain}.${window.location.hostname}`}
                      target="_blank" rel="noreferrer"
                      style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--accent)" }}>
                      {t.subdomain}
                    </a>
                  </td>
                  <td><code style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-3)" }}>{t.id.slice(0, 16)}…</code></td>
                  <td style={{ color: "var(--text-3)", fontSize: 12 }}>{timeAgo(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── AdminTcpPage ─────────────────────────────────────────────────────────────

function NewTcpMappingModal({ onCreate, onClose }: {
  onCreate: (data: { name: string; localPort: number; publicPort: number; description?: string }, onDone: () => void) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [publicPort, setPublicPort] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  function submit() {
    const lp = parseInt(localPort, 10);
    const pp = parseInt(publicPort, 10);
    if (!name.trim() || !lp || !pp) return;
    setSaving(true);
    onCreate(
      { name: name.trim(), localPort: lp, publicPort: pp, description: description.trim() || undefined },
      () => setSaving(false),
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title"><i className="ti ti-network" /> New TCP Port Mapping</div>
          <div className="icon-btn" onClick={onClose}><i className="ti ti-x" /></div>
        </div>
        <div className="modal-body" style={{ display: "grid", gap: 14 }}>
          <div>
            <label className="form-lbl">Name <span style={{ color: "var(--red)" }}>*</span></label>
            <input className="form-inp" placeholder="e.g. Postgres DB" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label className="form-lbl">Local Port <span style={{ color: "var(--red)" }}>*</span></label>
              <input className="form-inp" type="number" min={1} max={65535} placeholder="5432"
                value={localPort} onChange={(e) => setLocalPort(e.target.value)} />
            </div>
            <div>
              <label className="form-lbl">Public Port <span style={{ color: "var(--red)" }}>*</span></label>
              <input className="form-inp" type="number" min={1} max={65535} placeholder="19000"
                value={publicPort} onChange={(e) => setPublicPort(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="form-lbl">Description</label>
            <input className="form-inp" placeholder="Optional note" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving || !name.trim() || !localPort || !publicPort} onClick={submit}>
            {saving ? <><i className="ti ti-loader-2 spin" /> Creating…</> : <><i className="ti ti-plus" /> Create mapping</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function AdminTcpPage({ api, showToast, onConfirm }: {
  api: GatewayApi;
  showToast: (msg: string, type?: Toast["type"]) => void;
  onConfirm: (state: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void;
}) {
  const [mappings, setMappings] = useState<TcpPortMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    api.listTcpPortMappings()
      .then(setMappings)
      .catch((e: unknown) => showToast(e instanceof Error ? e.message : "Load failed", "red"))
      .finally(() => setLoading(false));
  }, [api, showToast]);

  useEffect(() => { refresh(); }, [refresh]);

  function handleCreate(
    data: { name: string; localPort: number; publicPort: number; description?: string },
    onDone: () => void,
  ) {
    api.createTcpPortMapping(data)
      .then((m) => {
        setMappings((prev) => [m, ...prev]);
        setShowCreate(false);
        showToast(`TCP mapping "${m.name}" created`, "green");
      })
      .catch((e: unknown) => {
        showToast(e instanceof Error ? e.message : "Create failed", "red");
        onDone();
      });
  }

  function requestDelete(id: string, name: string) {
    onConfirm({
      title: "Delete TCP mapping?",
      message: `This will permanently remove "${name}". Any clients using port mapping will lose connectivity.`,
      confirmLabel: "Delete mapping",
      danger: true,
      onConfirm: () => {
        api.deleteTcpPortMapping(id)
          .then(() => { setMappings((prev) => prev.filter((m) => m.id !== id)); showToast("Mapping deleted", "green"); })
          .catch((e: unknown) => showToast(e instanceof Error ? e.message : "Delete failed", "red"));
      },
    });
  }

  return (
    <div className="page-body">
      <div className="admin-hero">
        <div className="admin-hero-left">
          <div className="admin-hero-title"><i className="ti ti-network" />TCP Port Mappings<span className="admin-hero-badge">Admin</span></div>
          <div className="admin-hero-sub">Reserve public ports for TCP tunnels — databases, SSH, custom protocols</div>
        </div>
        <div className="admin-hero-right">
          <button className="btn-ghost" style={{ color: "#fff", borderColor: "rgba(255,255,255,0.2)" }}
            onClick={refresh} disabled={loading}>
            <i className={`ti ti-refresh${loading ? " spin" : ""}`} />
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <i className="ti ti-plus" /> New mapping
          </button>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-list" /> {mappings.length} mapping{mappings.length !== 1 ? "s" : ""}</div>
        </div>

        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-3)" }}>
            <i className="ti ti-loader-2 spin" style={{ fontSize: 22, display: "block", marginBottom: 8 }} />
            Loading…
          </div>
        ) : mappings.length === 0 ? (
          <div className="empty">
            <i className="ti ti-network-off" />
            <div className="empty-title">No TCP port mappings</div>
            <div className="empty-desc">
              Create a mapping to reserve a public port for TCP tunnels.
              Clients connect to the public port; the gateway forwards traffic to the local port.
            </div>
            <button className="btn-primary" style={{ margin: "0 auto" }} onClick={() => setShowCreate(true)}>
              <i className="ti ti-plus" /> New mapping
            </button>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Local Port</th>
                <th>Public Port</th>
                <th>Description</th>
                <th>Status</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 600, color: "var(--text-1)" }}>{m.name}</td>
                  <td><span className="port-tag">{m.localPort}</span></td>
                  <td><span className="port-tag public">{m.publicPort}</span></td>
                  <td style={{ color: "var(--text-3)", fontSize: 12 }}>{m.description ?? "—"}</td>
                  <td>
                    <span className={`action-badge ${m.enabled ? "create" : "other"}`}>
                      <i className={`ti ti-${m.enabled ? "circle-check" : "circle-x"}`} />
                      {m.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                  <td style={{ color: "var(--text-3)", fontSize: 12 }}>{timeAgo(m.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <div className="icon-btn danger" title="Delete" onClick={() => requestDelete(m.id, m.name)}>
                        <i className="ti ti-trash" />
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && <NewTcpMappingModal onCreate={handleCreate} onClose={() => setShowCreate(false)} />}
    </div>
  );
}

// ─── App (main) ───────────────────────────────────────────────────────────────

export function App() {
  // ── Theme ──────────────────────────────────────────────────────────────────
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem("ptx-theme") as Theme | null) ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ptx-theme", theme);
  }, [theme]);

  // ── Boot / screen ──────────────────────────────────────────────────────────
  const [appReady, setAppReady] = useState(false);
  const [screen, setScreen] = useState<"auth" | "app">("auth");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [authTab, setAuthTab] = useState<AuthTab>("login");
  const [currentPage, setCurrentPage] = useState<Page>("tunnels");
  const [inspectorSubdomain, setInspectorSubdomain] = useState<string | null>(null);

  // ── Auth forms ─────────────────────────────────────────────────────────────
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginPassShow, setLoginPassShow] = useState(false);
  const [regFirstName, setRegFirstName] = useState("");
  const [regLastName, setRegLastName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regPassShow, setRegPassShow] = useState(false);

  // ── User ───────────────────────────────────────────────────────────────────
  const [user, setUser] = useState<UserInfo | null>(null);
  const [accessToken, setAccessToken] = useState("");

  // ── Data ───────────────────────────────────────────────────────────────────
  const [tunnels, setTunnels] = useState<TunnelRecord[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [aiInsightVisible, setAiInsightVisible] = useState(true);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [showNewTunnel, setShowNewTunnel] = useState(false);
  const [newTunnelSubdomain, setNewTunnelSubdomain] = useState("");
  const [showNewKey, setShowNewKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(["tunnel:create", "tunnel:read", "tunnel:delete"]);
  const [createdKeyToken, setCreatedKeyToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // ── Toasts ─────────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const showToast = useCallback((message: string, type: Toast["type"] = "default") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  // ── API instance (never null — anonymous mode uses empty auth) ─────────────
  const api = useMemo(
    () => new GatewayApi(DEFAULT_GATEWAY, accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
    [accessToken],
  );

  // ── Clipboard ──────────────────────────────────────────────────────────────
  const copyToClipboard = useCallback(
    (text: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => showToast("Copied to clipboard!"))
        .catch(() => showToast("Copy failed", "red"));
    },
    [showToast],
  );

  // ── Keyboard shortcut ──────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCurrentPage("ai"); // Cmd+K → AI assistant
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // ── Gateway status poll (public endpoint, no auth) ─────────────────────────
  useEffect(() => {
    if (screen !== "app") return;
    const pubApi = new GatewayApi(DEFAULT_GATEWAY, {});
    const fetch = () =>
      void pubApi.getReadyz().then(setGatewayStatus).catch(() => {});
    fetch();
    const timer = setInterval(fetch, 30_000);
    return () => clearInterval(timer);
  }, [screen]);

  // ── Boot: restore session or detect anonymous mode ─────────────────────────
  useEffect(() => {
    function enterApp(token: string, userInfo: UserInfo, anon: boolean, initialTunnels: TunnelRecord[]) {
      setAccessToken(token);
      setUser(userInfo);
      setIsAnonymous(anon);
      setTunnels(initialTunnels);
      setScreen("app");
      setAppReady(true);
    }

    function tryAnonymous() {
      const anonApi = new GatewayApi(DEFAULT_GATEWAY, {});
      anonApi
        .listTunnels()
        .then((tuns) => {
          enterApp("", { email: "local@anonymous", name: "Anonymous", initials: "AN", role: "admin" }, true, tuns);
        })
        .catch(() => {
          setScreen("auth");
          setAppReady(true);
        });
    }

    const session = loadSession();
    if (session) {
      const inst = new GatewayApi(DEFAULT_GATEWAY, { accessToken: session.token });
      inst
        .listTunnels()
        .then((tuns) => {
          enterApp(session.token, session.user, false, tuns);
        })
        .catch(() => {
          clearSession();
          tryAnonymous();
        });
    } else {
      tryAnonymous();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load API keys when navigating to that page ─────────────────────────────
  useEffect(() => {
    if (currentPage !== "api" || screen !== "app") return;
    setLoading(true);
    api
      .listApiKeys()
      .then(setApiKeys)
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to load API keys", "red");
      })
      .finally(() => setLoading(false));
  }, [currentPage, screen, api, showToast]);

  // ── Auth ───────────────────────────────────────────────────────────────────

  const doLogin = () => {
    if (!loginEmail.trim()) { showToast("Please enter your email", "red"); return; }
    setLoading(true);
    new GatewayApi(DEFAULT_GATEWAY, {})
      .login(loginEmail.trim(), loginPassword)
      .then((result) => {
        const info: UserInfo = {
          email: result.user.email,
          name: deriveName(result.user.email),
          initials: deriveInitials(result.user.email),
          role: result.user.role,
        };
        setUser(info);
        setAccessToken(result.accessToken);
        setIsAnonymous(false);
        saveSession(result.accessToken, info);
        showToast("Welcome back! 👋", "green");
        const inst = new GatewayApi(DEFAULT_GATEWAY, { accessToken: result.accessToken });
        void inst.listTunnels().then(setTunnels).catch(() => {});
        setScreen("app");
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Login failed", "red");
      })
      .finally(() => setLoading(false));
  };

  const doRegister = () => {
    if (!regEmail.trim() || !regPassword.trim()) {
      showToast("Please fill in email and password", "red");
      return;
    }
    setLoading(true);
    new GatewayApi(DEFAULT_GATEWAY, {})
      .register(regEmail.trim(), regPassword)
      .then((result) => {
        const displayName = [regFirstName.trim(), regLastName.trim()].filter(Boolean).join(" ");
        const initials =
          regFirstName && regLastName
            ? (regFirstName[0] + regLastName[0]).toUpperCase()
            : deriveInitials(result.user.email);
        const info: UserInfo = {
          email: result.user.email,
          name: displayName || deriveName(result.user.email),
          initials,
          role: result.user.role,
        };
        setUser(info);
        setAccessToken(result.accessToken);
        setIsAnonymous(false);
        saveSession(result.accessToken, info);
        showToast("Account created! Welcome 🎉", "green");
        setTimeout(() => setScreen("app"), 400);
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Registration failed", "red");
      })
      .finally(() => setLoading(false));
  };

  const doLogout = () => {
    clearSession();
    setAccessToken("");
    setUser(null);
    setIsAnonymous(false);
    setTunnels([]);
    setApiKeys([]);
    setCurrentPage("tunnels");
    setAiInsightVisible(true);
    // Clear auth form state so credentials don't persist after logout
    setLoginEmail("");
    setLoginPassword("");
    setRegEmail("");
    setRegPassword("");
    setRegFirstName("");
    setRegLastName("");
    setScreen("auth");
    showToast("Signed out");
  };

  // ── Tunnels ────────────────────────────────────────────────────────────────

  const refreshTunnels = useCallback(() => {
    setLoading(true);
    api
      .listTunnels()
      .then(setTunnels)
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to load tunnels", "red");
      })
      .finally(() => setLoading(false));
  }, [api, showToast]);

  const createTunnel = () => {
    if (newTunnelSubdomain.trim().length < 3) {
      showToast("Subdomain must be at least 3 characters", "red");
      return;
    }
    setLoading(true);
    api
      .createTunnel(newTunnelSubdomain.trim().toLowerCase())
      .then(() => {
        setNewTunnelSubdomain("");
        setShowNewTunnel(false);
        return api.listTunnels();
      })
      .then(setTunnels)
      .then(() => showToast("Tunnel created!", "green"))
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to create tunnel", "red");
      })
      .finally(() => setLoading(false));
  };

  const requestDeleteTunnel = (id: string, subdomain: string) => {
    setConfirm({
      title: "Stop tunnel?",
      message: `This will permanently stop "${subdomain}". Any active connections will be dropped immediately.`,
      confirmLabel: "Stop tunnel",
      danger: true,
      onConfirm: () => {
        setConfirm(null);
        setLoading(true);
        api
          .deleteTunnel(id)
          .then(() => api.listTunnels())
          .then(setTunnels)
          .then(() => showToast("Tunnel stopped", "green"))
          .catch((err: unknown) => {
            showToast(err instanceof Error ? err.message : "Failed to stop tunnel", "red");
          })
          .finally(() => setLoading(false));
      },
    });
  };

  // ── API Keys ───────────────────────────────────────────────────────────────

  const loadApiKeys = useCallback(() => {
    setLoading(true);
    api
      .listApiKeys()
      .then(setApiKeys)
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to load API keys", "red");
      })
      .finally(() => setLoading(false));
  }, [api, showToast]);

  const createApiKey = () => {
    if (!newKeyName.trim()) { showToast("Enter a key name", "red"); return; }
    setLoading(true);
    api
      .createApiKey(newKeyName.trim(), newKeyScopes.join(","))
      .then((result) => {
        if (result.apiKey?.token) setCreatedKeyToken(result.apiKey.token);
        setNewKeyName("");
        setShowNewKey(false);
        return api.listApiKeys();
      })
      .then(setApiKeys)
      .then(() => showToast("API key generated!", "green"))
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to create key", "red");
      })
      .finally(() => setLoading(false));
  };

  const requestRevokeKey = (id: string, name: string) => {
    setConfirm({
      title: "Revoke API key?",
      message: `Revoking "${name}" will immediately invalidate it. Any services or scripts using this key will lose access.`,
      confirmLabel: "Revoke key",
      danger: true,
      onConfirm: () => {
        setConfirm(null);
        setLoading(true);
        api
          .revokeApiKey(id)
          .then(() => api.listApiKeys())
          .then(setApiKeys)
          .then(() => showToast("API key revoked", "green"))
          .catch((err: unknown) => {
            showToast(err instanceof Error ? err.message : "Failed to revoke key", "red");
          })
          .finally(() => setLoading(false));
      },
    });
  };

  // ── Boot splash ────────────────────────────────────────────────────────────
  if (!appReady) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        height: "100vh", background: "var(--bg-page)", gap: 16,
      }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: "#fff" }}>
          <i className="ti ti-topology-star" />
        </div>
        <i className="ti ti-loader-2 spin" style={{ fontSize: 24, color: "var(--accent)" }} />
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── AUTH SCREEN ──────────────────────────────────────────────────── */}
      {screen === "auth" && (
        <AuthScreen
          authTab={authTab} setAuthTab={setAuthTab}
          theme={theme} setTheme={setThemeState}
          loginEmail={loginEmail} setLoginEmail={setLoginEmail}
          loginPassword={loginPassword} setLoginPassword={setLoginPassword}
          loginPassShow={loginPassShow} setLoginPassShow={setLoginPassShow}
          regFirstName={regFirstName} setRegFirstName={setRegFirstName}
          regLastName={regLastName} setRegLastName={setRegLastName}
          regEmail={regEmail} setRegEmail={setRegEmail}
          regPassword={regPassword} setRegPassword={setRegPassword}
          regPassShow={regPassShow} setRegPassShow={setRegPassShow}
          loading={loading} doLogin={doLogin} doRegister={doRegister}
        />
      )}

      {/* ── APP SCREEN ───────────────────────────────────────────────────── */}
      {screen === "app" && (
        <div id="screen-app" className="active">
          {/* ── Sidebar ──────────────────────────────────────────────────── */}
          <aside className="sidebar">
            <div className="logo">
              <div className="logo-icon"><i className="ti ti-topology-star" /></div>
              <span className="logo-wordmark">Portivox <span className="logo-badge">AI</span></span>
            </div>

            <div className="nav-body">
              <span className="nav-group-label">Workspace</span>
              {(["tunnels", "devices", "ai"] as Page[]).map((page) => (
                <div key={page} className={`nav-item ${currentPage === page ? "active" : ""}`}
                  onClick={() => setCurrentPage(page)}>
                  <i className={`ti ti-${page === "tunnels" ? "topology-star-3" : page === "devices" ? "device-laptop" : "sparkles"}`} />
                  {PAGE_TITLES[page]}
                  {page === "tunnels" && tunnels.filter((t) => t.active).length > 0 && (
                    <span className="nav-badge">{tunnels.filter((t) => t.active).length}</span>
                  )}
                </div>
              ))}

              <span className="nav-group-label">Analytics</span>
              <div className={`nav-item ${currentPage === "usage" ? "active" : ""}`}
                onClick={() => setCurrentPage("usage")}>
                <i className="ti ti-chart-bar" /> {PAGE_TITLES.usage}
              </div>

              <span className="nav-group-label">Developer</span>
              <div className={`nav-item ${currentPage === "api" ? "active" : ""}`}
                onClick={() => setCurrentPage("api")}>
                <i className="ti ti-code" /> {PAGE_TITLES.api}
              </div>
              <div className={`nav-item ${currentPage === "inspector" ? "active" : ""}`}
                onClick={() => { setInspectorSubdomain(null); setCurrentPage("inspector"); }}>
                <i className="ti ti-eye" /> {PAGE_TITLES.inspector}
              </div>

              <span className="nav-group-label">Account</span>
              {(["org", "settings", "billing"] as Page[]).map((page) => (
                <div key={page} className={`nav-item ${currentPage === page ? "active" : ""}`}
                  onClick={() => setCurrentPage(page)}>
                  <i className={`ti ti-${page === "org" ? "building" : page === "settings" ? "settings" : "credit-card"}`} />
                  {PAGE_TITLES[page]}
                </div>
              ))}

              {/* Admin section — only visible to admin/owner roles */}
              {hasAdminRole(user?.role) && (
                <>
                  <span className="nav-admin-label">
                    <span className="nav-admin-dot" />
                    Administration
                  </span>
                  <div className={`nav-item ${currentPage === "admin:overview" ? "active" : ""}`}
                    onClick={() => setCurrentPage("admin:overview")}>
                    <i className="ti ti-layout-dashboard" /> Overview
                    <span className="nav-admin-badge">Admin</span>
                  </div>
                  <div className={`nav-item ${currentPage === "admin:audit" ? "active" : ""}`}
                    onClick={() => setCurrentPage("admin:audit")}>
                    <i className="ti ti-clipboard-list" /> Audit Log
                  </div>
                  <div className={`nav-item ${currentPage === "admin:gateway" ? "active" : ""}`}
                    onClick={() => setCurrentPage("admin:gateway")}>
                    <i className="ti ti-server-cog" /> Gateway
                  </div>
                  <div className={`nav-item ${currentPage === "admin:tcp" ? "active" : ""}`}
                    onClick={() => setCurrentPage("admin:tcp")}>
                    <i className="ti ti-network" /> TCP Ports
                  </div>
                </>
              )}
            </div>

            <div className="theme-toggle-wrap">
              <div className="theme-toggle">
                <button className={`theme-btn ${theme === "light" ? "active" : ""}`} onClick={() => setThemeState("light")}>
                  <i className="ti ti-sun" /> Light
                </button>
                <button className={`theme-btn ${theme === "dark" ? "active" : ""}`} onClick={() => setThemeState("dark")}>
                  <i className="ti ti-moon" /> Dark
                </button>
              </div>
            </div>

            <div className="user-row" onClick={() => setCurrentPage("settings")}>
              <div className="avatar">{user?.initials ?? "AN"}</div>
              <div style={{ minWidth: 0 }}>
                <div className="user-name">{user?.name ?? "Anonymous"}</div>
                <div className="user-plan">
                  {isAnonymous ? "No auth" : user?.role === "owner" ? "Owner" : user?.role === "admin" ? "Admin" : "Member"}
                </div>
              </div>
              <i className="ti ti-chevron-right user-chevron" />
            </div>
          </aside>

          {/* ── Main ─────────────────────────────────────────────────────── */}
          <div className="main">
            <header className="topbar">
              <div className="topbar-left">
                <div className="breadcrumb">
                  <span className="breadcrumb-root">Portivox</span>
                  <span className="breadcrumb-sep">/</span>
                  {isAdminPage(currentPage) && (
                    <>
                      <span className="breadcrumb-root" style={{ color: "var(--red)", cursor: "pointer" }}
                        onClick={() => setCurrentPage("admin:overview")}>Admin</span>
                      <span className="breadcrumb-sep">/</span>
                    </>
                  )}
                  <span className="breadcrumb-current">{PAGE_TITLES[currentPage]}</span>
                </div>
              </div>
              <div className="topbar-right">
                <div className="search-box" onClick={() => setCurrentPage("ai")} style={{ cursor: "pointer" }}>
                  <i className="ti ti-search" />
                  <span>Search or ask AI…</span>
                  <span className="search-shortcut">⌘K</span>
                </div>
                <div
                  className="notif-btn"
                  title={gatewayStatus?.ready ? "Gateway healthy" : "Gateway status unknown"}
                  style={{ color: gatewayStatus?.ready ? "var(--green)" : "var(--text-3)" }}
                >
                  <i className={`ti ti-${gatewayStatus?.ready ? "circle-check" : "circle-dashed"}`} />
                </div>
                <button className="ai-btn" onClick={() => setCurrentPage("ai")}>
                  <i className="ti ti-sparkles" /> Ask AI
                </button>
                <button className="logout-btn" onClick={doLogout}>
                  <i className="ti ti-logout" /> Log out
                </button>
              </div>
            </header>

            <div className="content">
              {currentPage === "tunnels" && (
                <TunnelsPage
                  tunnels={tunnels}
                  loading={loading}
                  gatewayStatus={gatewayStatus}
                  aiInsightVisible={aiInsightVisible}
                  setAiInsightVisible={setAiInsightVisible}
                  onRefresh={refreshTunnels}
                  onNewTunnel={() => setShowNewTunnel(true)}
                  onDeleteTunnel={requestDeleteTunnel}
                  onCopy={copyToClipboard}
                  onInspect={(sub) => { setInspectorSubdomain(sub); setCurrentPage("inspector"); }}
                />
              )}
              {currentPage === "devices" && (
                <DevicesPage user={user} onCopy={copyToClipboard} />
              )}
              {currentPage === "ai" && <AiPage />}
              {currentPage === "usage" && (
                <UsagePage api={api} tunnelCount={tunnels.length} />
              )}
              {currentPage === "api" && (
                <ApiKeysPage
                  apiKeys={apiKeys}
                  loading={loading}
                  createdKeyToken={createdKeyToken}
                  onDismissToken={() => setCreatedKeyToken(null)}
                  onNewKey={() => setShowNewKey(true)}
                  onRevokeKey={requestRevokeKey}
                  onCopy={copyToClipboard}
                  onRefresh={loadApiKeys}
                />
              )}
              {currentPage === "org" && <OrgPage user={user} />}
              {currentPage === "settings" && (
                <SettingsPage
                  user={user}
                  isAnonymous={isAnonymous}
                  api={api}
                  showToast={showToast}
                  onLogout={doLogout}
                />
              )}
              {currentPage === "billing" && <BillingPage showToast={showToast} />}

              {/* ── Admin pages ── */}
              {currentPage === "admin:overview" && hasAdminRole(user?.role) && (
                <AdminOverviewPage api={api} showToast={showToast} />
              )}
              {currentPage === "admin:audit" && hasAdminRole(user?.role) && (
                <AdminAuditPage api={api} showToast={showToast} />
              )}
              {currentPage === "admin:gateway" && hasAdminRole(user?.role) && (
                <AdminGatewayPage
                  api={api}
                  tunnels={tunnels}
                  showToast={showToast}
                  onConfirm={setConfirm}
                />
              )}
              {currentPage === "admin:tcp" && hasAdminRole(user?.role) && (
                <AdminTcpPage api={api} showToast={showToast} onConfirm={setConfirm} />
              )}
              {currentPage === "inspector" && (
                <InspectorPage
                  api={api}
                  tunnels={tunnels}
                  initialSubdomain={inspectorSubdomain}
                  onBack={() => setCurrentPage("tunnels")}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {showNewTunnel && (
        <NewTunnelModal
          subdomain={newTunnelSubdomain}
          setSubdomain={setNewTunnelSubdomain}
          loading={loading}
          onCreate={createTunnel}
          onClose={() => { setShowNewTunnel(false); setNewTunnelSubdomain(""); }}
        />
      )}
      {showNewKey && (
        <NewKeyModal
          name={newKeyName}
          setName={setNewKeyName}
          scopes={newKeyScopes}
          setScopes={setNewKeyScopes}
          loading={loading}
          onCreate={createApiKey}
          onClose={() => { setShowNewKey(false); setNewKeyName(""); setNewKeyScopes(["tunnel:create", "tunnel:read", "tunnel:delete"]); }}
        />
      )}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}

      {/* ── Toasts ────────────────────────────────────────────────────────── */}
      <div className="toast-wrap">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.type !== "default" ? ` ${toast.type}` : ""}`}>
            <i className={`ti ti-${toast.type === "green" ? "check" : toast.type === "red" ? "alert-circle" : "info-circle"}`} />
            {toast.message}
          </div>
        ))}
      </div>
    </>
  );
}
