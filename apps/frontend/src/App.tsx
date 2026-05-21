import { useCallback, useEffect, useMemo, useState } from "react";
import { GatewayApi, type ApiKeyRecord, type TunnelRecord } from "./api";
import "./styles.css";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "";

type Page = "tunnels" | "devices" | "ai" | "usage" | "api" | "org" | "settings" | "billing";
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

const PAGE_TITLES: Record<Page, string> = {
  tunnels: "Tunnels",
  devices: "Devices",
  ai: "AI Assistant",
  usage: "Usage",
  api: "API Keys",
  org: "Organisation",
  settings: "Settings",
  billing: "Billing",
};

let toastSeq = 0;

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
  const host = window.location.hostname;
  return `${subdomain}.${host}`;
}

// ─── NewTunnelModal ───────────────────────────────────────────────────────────

function NewTunnelModal({
  subdomain,
  setSubdomain,
  loading,
  onCreate,
  onClose,
}: {
  subdomain: string;
  setSubdomain: (v: string) => void;
  loading: boolean;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <i className="ti ti-topology-star-3" /> New tunnel
          </div>
          <div className="icon-btn" onClick={onClose}>
            <i className="ti ti-x" />
          </div>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 16, lineHeight: 1.6 }}>
            Reserve a subdomain. Once a client connects using this subdomain,
            traffic will be routed automatically.
          </p>
          <label className="form-lbl">Subdomain</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <input
              className="form-inp"
              style={{ flex: 1 }}
              placeholder="myapp"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onCreate()}
              autoFocus
            />
            <span style={{ fontSize: 12, color: "var(--text-3)", whiteSpace: "nowrap" }}>
              .{window.location.hostname}
            </span>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={loading || !subdomain.trim()}
            onClick={onCreate}
          >
            <i className="ti ti-plus" /> Create tunnel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── NewKeyModal ──────────────────────────────────────────────────────────────

function NewKeyModal({
  name,
  setName,
  scopes,
  setScopes,
  loading,
  onCreate,
  onClose,
}: {
  name: string;
  setName: (v: string) => void;
  scopes: string;
  setScopes: (v: string) => void;
  loading: boolean;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <i className="ti ti-key" /> Generate API key
          </div>
          <div className="icon-btn" onClick={onClose}>
            <i className="ti ti-x" />
          </div>
        </div>
        <div className="modal-body">
          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <label className="form-lbl">Key name</label>
              <input
                className="form-inp"
                style={{ marginTop: 6, width: "100%" }}
                placeholder="e.g. ci-cd-key"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onCreate()}
                autoFocus
              />
            </div>
            <div>
              <label className="form-lbl">Scopes (comma-separated)</label>
              <input
                className="form-inp"
                style={{ marginTop: 6, width: "100%", fontFamily: "var(--mono)", fontSize: 12 }}
                value={scopes}
                onChange={(e) => setScopes(e.target.value)}
              />
              <p style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 6, lineHeight: 1.5 }}>
                Available: tunnel:create, tunnel:read, tunnel:delete, key:manage
              </p>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={loading || !name.trim()}
            onClick={onCreate}
          >
            <i className="ti ti-check" /> Generate key
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AuthScreen ───────────────────────────────────────────────────────────────

function AuthScreen({
  authTab,
  setAuthTab,
  theme,
  setTheme,
  loginEmail,
  setLoginEmail,
  loginPassword,
  setLoginPassword,
  loginPassShow,
  setLoginPassShow,
  regFirstName,
  setRegFirstName,
  regLastName,
  setRegLastName,
  regEmail,
  setRegEmail,
  regOrg,
  setRegOrg,
  regPassword,
  setRegPassword,
  regPassShow,
  setRegPassShow,
  loading,
  doLogin,
  doRegister,
}: {
  authTab: AuthTab;
  setAuthTab: (t: AuthTab) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  loginEmail: string;
  setLoginEmail: (v: string) => void;
  loginPassword: string;
  setLoginPassword: (v: string) => void;
  loginPassShow: boolean;
  setLoginPassShow: (v: boolean) => void;
  regFirstName: string;
  setRegFirstName: (v: string) => void;
  regLastName: string;
  setRegLastName: (v: string) => void;
  regEmail: string;
  setRegEmail: (v: string) => void;
  regOrg: string;
  setRegOrg: (v: string) => void;
  regPassword: string;
  setRegPassword: (v: string) => void;
  regPassShow: boolean;
  setRegPassShow: (v: boolean) => void;
  loading: boolean;
  doLogin: () => void;
  doRegister: () => void;
}) {
  return (
    <div id="screen-auth">
      {/* ── Left panel ─────────────────────────── */}
      <div className="auth-left">
        <div className="auth-left-inner">
          <div className="auth-brand">
            <div className="auth-brand-icon">
              <i className="ti ti-topology-star" />
            </div>
            <span className="auth-brand-name">
              Portivox <span className="auth-brand-badge">AI</span>
            </span>
          </div>

          <h1 className="auth-headline">
            Secure tunnels.<br />
            <em>AI superpowers.</em>
          </h1>
          <p className="auth-sub">
            Expose local ports to the internet in seconds — with intelligent
            monitoring, auto-optimization, and AI-assisted setup built right in.
          </p>

          <div className="auth-features">
            <div className="auth-feature">
              <div className="auth-feature-dot"><i className="ti ti-shield-lock" /></div>
              <span>End-to-end encrypted SSH tunnels</span>
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

      {/* ── Right panel ────────────────────────── */}
      <div className="auth-right">
        {/* Theme toggle */}
        <div className="auth-theme-top">
          <div className="theme-toggle" style={{ width: "fit-content" }}>
            <button
              className={`theme-btn ${theme === "light" ? "active" : ""}`}
              onClick={() => setTheme("light")}
            >
              <i className="ti ti-sun" />
            </button>
            <button
              className={`theme-btn ${theme === "dark" ? "active" : ""}`}
              onClick={() => setTheme("dark")}
            >
              <i className="ti ti-moon" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="auth-tabs">
          <button
            className={`auth-tab ${authTab === "login" ? "active" : ""}`}
            onClick={() => setAuthTab("login")}
          >
            Sign in
          </button>
          <button
            className={`auth-tab ${authTab === "register" ? "active" : ""}`}
            onClick={() => setAuthTab("register")}
          >
            Create account
          </button>
        </div>

        {/* LOGIN */}
        <div className={`auth-panel ${authTab === "login" ? "active" : ""}`}>
          <div className="auth-form-title">Welcome back</div>
          <div className="auth-form-sub">Sign in to your Portivox workspace</div>

          <div className="auth-form">
            <div>
              <label className="field-label" htmlFor="login-email">
                Email address
              </label>
              <input
                className="field-input"
                id="login-email"
                type="email"
                placeholder="you@company.com"
                autoComplete="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doLogin()}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="login-pass">
                Password
              </label>
              <div className="field-input-wrap">
                <input
                  className="field-input"
                  id="login-pass"
                  type={loginPassShow ? "text" : "password"}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doLogin()}
                />
                <i
                  className={`ti ${loginPassShow ? "ti-eye-off" : "ti-eye"} field-eye`}
                  onClick={() => setLoginPassShow(!loginPassShow)}
                />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: -6 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "var(--text-2)", cursor: "pointer" }}>
                <input type="checkbox" style={{ accentColor: "var(--accent)" }} /> Remember me
              </label>
              <a href="#" style={{ fontSize: 13 }}>Forgot password?</a>
            </div>
            <button className="auth-submit" disabled={loading} onClick={doLogin}>
              <i className="ti ti-login" /> Sign in
            </button>
          </div>
          <div className="auth-footer-note">
            Don't have an account?{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); setAuthTab("register"); }}>
              Create one free →
            </a>
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
                <input
                  className="field-input"
                  type="text"
                  placeholder="Asiqur"
                  value={regFirstName}
                  onChange={(e) => setRegFirstName(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label">Last name</label>
                <input
                  className="field-input"
                  type="text"
                  placeholder="Rahman"
                  value={regLastName}
                  onChange={(e) => setRegLastName(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="field-label">Work email</label>
              <input
                className="field-input"
                type="email"
                placeholder="you@company.com"
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">Organisation</label>
              <input
                className="field-input"
                type="text"
                placeholder="AIUB / Acme Corp"
                value={regOrg}
                onChange={(e) => setRegOrg(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">Password</label>
              <div className="field-input-wrap">
                <input
                  className="field-input"
                  type={regPassShow ? "text" : "password"}
                  placeholder="Min. 8 characters"
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doRegister()}
                />
                <i
                  className={`ti ${regPassShow ? "ti-eye-off" : "ti-eye"} field-eye`}
                  onClick={() => setRegPassShow(!regPassShow)}
                />
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: "12.5px", color: "var(--text-2)", cursor: "pointer", lineHeight: 1.5 }}>
              <input type="checkbox" style={{ accentColor: "var(--accent)", marginTop: 2, flexShrink: 0 }} />
              I agree to the <a href="#">Terms of Service</a>&nbsp;and&nbsp;<a href="#">Privacy Policy</a>
            </label>
            <button className="auth-submit" disabled={loading} onClick={doRegister}>
              <i className="ti ti-user-plus" /> Create account
            </button>
          </div>
          <div className="auth-footer-note">
            Already have an account?{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); setAuthTab("login"); }}>
              Sign in →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── TunnelsPage ──────────────────────────────────────────────────────────────

function TunnelsPage({
  tunnels,
  loading,
  aiInsightVisible,
  setAiInsightVisible,
  onRefresh,
  onNewTunnel,
  onDeleteTunnel,
  onCopy,
}: {
  tunnels: TunnelRecord[];
  loading: boolean;
  aiInsightVisible: boolean;
  setAiInsightVisible: (v: boolean) => void;
  onRefresh: () => void;
  onNewTunnel: () => void;
  onDeleteTunnel: (id: string) => void;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="page">
      {/* Metrics */}
      <div className="metrics">
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-plug-connected" /></div>
            Active tunnels
          </div>
          <div className="metric-val">{tunnels.length}</div>
          <div className="metric-sub">
            {tunnels.length > 0 ? (
              <span className="up">↑ {tunnels.length} currently running</span>
            ) : (
              "None active"
            )}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-transfer" /></div>
            Data transferred
          </div>
          <div className="metric-val" style={{ fontSize: 22 }}>—</div>
          <div className="metric-sub">Monitoring coming soon</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-activity" /></div>
            Avg latency
          </div>
          <div className="metric-val" style={{ fontSize: 22 }}>—</div>
          <div className="metric-sub">Monitoring coming soon</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-server" /></div>
            Gateway
          </div>
          <div className="metric-val" style={{ fontSize: 15, paddingTop: 5, fontWeight: 600 }}>
            {window.location.hostname}
          </div>
          <div className="metric-sub up">↑ Online</div>
        </div>
      </div>

      {/* AI insight banner */}
      {aiInsightVisible && (
        <div className="ai-insight">
          <div className="ai-badge"><i className="ti ti-sparkles" /></div>
          <div style={{ flex: 1 }}>
            <div className="ai-insight-label">AI insight</div>
            <div className="ai-insight-text">
              {tunnels.length === 0 ? (
                <>No active tunnels found. Click <strong>New tunnel</strong> to reserve a subdomain, or run <strong>portivox open &lt;port&gt;</strong> from any registered device.</>
              ) : (
                <>You have <strong>{tunnels.length}</strong> active tunnel{tunnels.length !== 1 ? "s" : ""}. Use <strong>portivox list</strong> from the CLI to check status from any device.</>
              )}
            </div>
          </div>
          <i className="ti ti-x ai-dismiss" onClick={() => setAiInsightVisible(false)} />
        </div>
      )}

      {/* Live sessions table */}
      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-topology-star-3" /> Live sessions
          </div>
          <div className="section-actions">
            <button className="btn-ghost" onClick={onRefresh} disabled={loading}>
              <i className="ti ti-refresh" /> Refresh
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
              Start a tunnel from the CLI with <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>portivox open &lt;port&gt;</code>, or click below to reserve a subdomain.
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
                      <span className="status-dot dot-green" />Live
                    </td>
                    <td>
                      <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                        <div
                          className="icon-btn"
                          title="Copy URL"
                          onClick={() => onCopy(url)}
                        >
                          <i className="ti ti-copy" />
                        </div>
                        <div
                          className="icon-btn"
                          title="Open in browser"
                          onClick={() => window.open(`http://${url}`, "_blank")}
                        >
                          <i className="ti ti-external-link" />
                        </div>
                        <button
                          className="stop-btn"
                          disabled={loading}
                          onClick={() => onDeleteTunnel(tunnel.id)}
                        >
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

// ─── DevicesPage ──────────────────────────────────────────────────────────────

function DevicesPage({ onCopy }: { onCopy: (text: string) => void }) {
  const cmd = "portivox register <your-token>";
  return (
    <div className="page">
      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-device-laptop" /> Registered devices
          </div>
          <button className="btn-primary">
            <i className="ti ti-plus" /> Add device
          </button>
        </div>
        <div className="empty">
          <i className="ti ti-device-laptop" />
          <div className="empty-title">No registered devices</div>
          <div className="empty-desc">
            Register a device by installing the Portivox client and running the registration command below.
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-terminal-2" /> Register a new device
          </div>
        </div>
        <div style={{ padding: "18px 22px" }}>
          <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 12 }}>
            Install the Portivox client on your device, then run:
          </p>
          <div className="code-block">
            <code>{cmd}</code>
            <div
              className="icon-btn"
              style={{ borderColor: "rgba(255,255,255,0.1)", color: "#b4a9ff", background: "transparent" }}
              onClick={() => onCopy(cmd)}
              title="Copy"
            >
              <i className="ti ti-copy" />
            </div>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 10 }}>
            Need the client?{" "}
            <a href="https://github.com" target="_blank" rel="noreferrer">
              Download for Linux / macOS / Windows →
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── AiPage ───────────────────────────────────────────────────────────────────

function AiPage() {
  const cards = [
    { icon: "ti-plug", title: "Expose local port", desc: "Create a secure tunnel to share your dev server with the world" },
    { icon: "ti-stethoscope", title: "Diagnose idle tunnel", desc: "Investigate why a tunnel has zero inbound connections" },
    { icon: "ti-database", title: "Tunnel a database", desc: "Securely expose PostgreSQL, MySQL, or Redis" },
    { icon: "ti-chart-dots-3", title: "Optimize bandwidth", desc: "Analyze usage and suggest ways to cut data consumption" },
    { icon: "ti-shield-lock", title: "Security audit", desc: "Review open tunnels for internet exposure risks" },
    { icon: "ti-clock-play", title: "Auto-close rules", desc: "Stop tunnels automatically after an idle timeout" },
  ];

  return (
    <div className="page">
      <div className="ai-page-banner">
        <div className="ai-page-text">
          <div className="ai-page-title">AI assistant</div>
          <div className="ai-page-sub">
            Ask anything about your tunnels, devices, or usage. Set up connections,
            diagnose issues, generate CLI commands, or review your security posture.
          </div>
        </div>
        <i className="ti ti-robot ai-page-icon" />
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-bolt" /> Quick actions
          </div>
        </div>
        <div className="ai-grid">
          {cards.map((card) => (
            <button key={card.title} className="ai-card">
              <div className="ai-card-icon">
                <i className={`ti ${card.icon}`} />
              </div>
              <div>
                <div className="ai-card-title">{card.title}</div>
                <div className="ai-card-desc">{card.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── UsagePage ────────────────────────────────────────────────────────────────

function UsagePage({ tunnelCount }: { tunnelCount: number }) {
  return (
    <div className="page">
      <div className="metrics" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-transfer" /></div>
            Data used
          </div>
          <div className="metric-val" style={{ fontSize: 22 }}>—</div>
          <div className="metric-sub">Analytics coming soon</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-clock" /></div>
            Active tunnels
          </div>
          <div className="metric-val">{tunnelCount}</div>
          <div className="metric-sub">Currently running</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <div className="metric-icon"><i className="ti ti-arrow-bounce" /></div>
            Requests proxied
          </div>
          <div className="metric-val" style={{ fontSize: 22 }}>—</div>
          <div className="metric-sub">Analytics coming soon</div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-chart-bar" /> Bandwidth usage
          </div>
        </div>
        <div className="usage-wrap">
          <div className="usage-row">
            <span>Usage data</span>
            <span style={{ color: "var(--text-3)" }}>Not yet available</span>
          </div>
          <div className="usage-bar">
            <div className="usage-fill" style={{ width: "0%" }} />
          </div>
          <div className="usage-note">Detailed analytics will be available in a future release.</div>
        </div>
      </div>
    </div>
  );
}

// ─── ApiKeysPage ──────────────────────────────────────────────────────────────

function ApiKeysPage({
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
  onRevokeKey: (id: string) => void;
  onCopy: (text: string) => void;
  onRefresh: () => void;
}) {
  const activeKeys = apiKeys.filter((k) => !k.revoked);

  return (
    <div className="page">
      {/* New-key token banner */}
      {createdKeyToken && (
        <div className="ai-insight" style={{ borderColor: "rgba(0,184,148,0.2)", background: "var(--green-bg)", marginBottom: 16 }}>
          <div className="ai-badge" style={{ background: "var(--green)" }}>
            <i className="ti ti-check" />
          </div>
          <div style={{ flex: 1 }}>
            <div className="ai-insight-label" style={{ color: "var(--green)" }}>
              Key generated — copy now
            </div>
            <div className="ai-insight-text" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
              <span className="url-pill" style={{ userSelect: "all", cursor: "text" }}>
                {createdKeyToken}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-2)" }}>
                This token will not be shown again.
              </span>
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
          <div className="section-title">
            <i className="ti ti-code" /> API keys
          </div>
          <div className="section-actions">
            <button className="btn-ghost" onClick={onRefresh} disabled={loading}>
              <i className="ti ti-refresh" /> Refresh
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
                        <span key={s} className="chip chip-purple" style={{ fontSize: 10 }}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ color: "var(--text-3)", fontSize: 12 }}>
                    {new Date(key.createdAt).toLocaleDateString()}
                  </td>
                  <td>
                    <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                      <button
                        className="stop-btn"
                        disabled={loading}
                        onClick={() => onRevokeKey(key.id)}
                      >
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
  return (
    <div className="page">
      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-building" /> Organisation
          </div>
        </div>
        <div style={{ padding: "20px 22px", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700, color: "var(--accent)", flexShrink: 0 }}>
            {user?.initials?.[0] ?? "P"}
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-1)" }}>
              My Organisation
            </div>
            <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 3 }}>
              1 member · Self-hosted
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-users" /> Members
          </div>
          <button className="btn-primary">
            <i className="ti ti-user-plus" /> Invite
          </button>
        </div>
        {user ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div className="avatar" style={{ width: 28, height: 28, fontSize: 10 }}>
                      {user.initials}
                    </div>
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
            <div className="empty-title">No members yet</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SettingsPage ─────────────────────────────────────────────────────────────

function SettingsPage({
  user,
  settingsName,
  setSettingsName,
  settingsLastName,
  setSettingsLastName,
  showToast,
}: {
  user: UserInfo | null;
  settingsName: string;
  setSettingsName: (v: string) => void;
  settingsLastName: string;
  setSettingsLastName: (v: string) => void;
  showToast: (msg: string, type?: "default" | "green" | "red") => void;
}) {
  return (
    <div className="page">
      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-user-circle" /> Profile
          </div>
        </div>
        <div className="form-body">
          <div className="form-row">
            <div className="form-field">
              <label className="form-lbl">First name</label>
              <input
                type="text"
                className="form-inp"
                value={settingsName}
                onChange={(e) => setSettingsName(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="form-lbl">Last name</label>
              <input
                type="text"
                className="form-inp"
                value={settingsLastName}
                onChange={(e) => setSettingsLastName(e.target.value)}
              />
            </div>
          </div>
          <div className="form-field">
            <label className="form-lbl">Email address</label>
            <input
              type="email"
              className="form-inp"
              value={user?.email ?? ""}
              disabled
            />
          </div>

          <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
          <div style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text-2)", padding: "0 0 4px" }}>
            Change password
          </div>
          <div className="form-field">
            <label className="form-lbl">Current password</label>
            <input type="password" className="form-inp" placeholder="••••••••••" />
          </div>
          <div className="form-field">
            <label className="form-lbl">New password</label>
            <input type="password" className="form-inp" placeholder="Min. 8 characters" />
          </div>
          <div className="form-field">
            <label className="form-lbl">Confirm new password</label>
            <input type="password" className="form-inp" placeholder="Repeat new password" />
          </div>
          <button className="btn-save" onClick={() => showToast("Changes saved!", "green")}>
            <i className="ti ti-check" /> Save changes
          </button>
        </div>
      </div>

      <div className="section" style={{ borderColor: "rgba(225,112,85,0.25)" }}>
        <div className="section-head">
          <div className="section-title" style={{ color: "var(--red)" }}>
            <i className="ti ti-alert-triangle" style={{ color: "var(--red)" }} /> Danger zone
          </div>
        </div>
        <div style={{ padding: "18px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: "13.5px", fontWeight: 500 }}>Delete account</div>
            <div style={{ fontSize: "12.5px", color: "var(--text-2)", marginTop: 3 }}>
              Permanently delete your account and all associated data. This cannot be undone.
            </div>
          </div>
          <button style={{ padding: "8px 16px", background: "var(--red-bg)", color: "var(--red)", border: "1px solid rgba(225,112,85,0.25)", borderRadius: "var(--r-md)", fontSize: 13, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "var(--font)", flexShrink: 0 }}>
            Delete account
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── BillingPage ──────────────────────────────────────────────────────────────

function BillingPage({
  showToast,
}: {
  showToast: (msg: string, type?: "default" | "green" | "red") => void;
}) {
  const [invoiceOrg, setInvoiceOrg] = useState("My Organisation");
  const [taxId, setTaxId] = useState("");
  const [invoiceEmail, setInvoiceEmail] = useState("");

  return (
    <div className="page">
      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-credit-card" /> Current plan
          </div>
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
          <div className="section-title">
            <i className="ti ti-file-invoice" /> Invoices
          </div>
        </div>
        <div className="empty">
          <i className="ti ti-receipt-off" />
          <div className="empty-title">No invoices</div>
          <div className="empty-desc">
            Your self-hosted instance has no billing requirements.
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">
            <i className="ti ti-building" /> Invoice details
          </div>
        </div>
        <div className="form-body">
          <div className="form-field">
            <label className="form-lbl">Name on invoice</label>
            <input
              type="text"
              className="form-inp"
              value={invoiceOrg}
              onChange={(e) => setInvoiceOrg(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label className="form-lbl">Tax ID</label>
            <input
              type="text"
              className="form-inp"
              placeholder="e.g. VAT BE0123456789"
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label className="form-lbl">Invoice email</label>
            <input
              type="email"
              className="form-inp"
              placeholder="billing@company.com"
              value={invoiceEmail}
              onChange={(e) => setInvoiceEmail(e.target.value)}
            />
          </div>
          <button
            className="btn-save"
            onClick={() => showToast("Invoice details saved!", "green")}
          >
            <i className="ti ti-check" /> Save details
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── App (main) ───────────────────────────────────────────────────────────────

export function App() {
  // ── Theme ──────────────────────────────────────────────────────────────────
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem("ptx-theme") as Theme | null) ?? "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ptx-theme", theme);
  }, [theme]);

  // ── Screen / nav ───────────────────────────────────────────────────────────
  const [screen, setScreen] = useState<"auth" | "app">("auth");
  const [authTab, setAuthTab] = useState<AuthTab>("login");
  const [currentPage, setCurrentPage] = useState<Page>("tunnels");

  // ── Auth forms ─────────────────────────────────────────────────────────────
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginPassShow, setLoginPassShow] = useState(false);
  const [regFirstName, setRegFirstName] = useState("");
  const [regLastName, setRegLastName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regOrg, setRegOrg] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regPassShow, setRegPassShow] = useState(false);

  // ── User ───────────────────────────────────────────────────────────────────
  const [user, setUser] = useState<UserInfo | null>(null);
  const [accessToken, setAccessToken] = useState("");

  // ── Settings form ──────────────────────────────────────────────────────────
  const [settingsName, setSettingsName] = useState("");
  const [settingsLastName, setSettingsLastName] = useState("");

  // ── Data ───────────────────────────────────────────────────────────────────
  const [tunnels, setTunnels] = useState<TunnelRecord[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [aiInsightVisible, setAiInsightVisible] = useState(true);

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [showNewTunnel, setShowNewTunnel] = useState(false);
  const [newTunnelSubdomain, setNewTunnelSubdomain] = useState("");
  const [showNewKey, setShowNewKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState("tunnel:create,tunnel:read,tunnel:delete");
  const [createdKeyToken, setCreatedKeyToken] = useState<string | null>(null);

  // ── Toasts ─────────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: Toast["type"] = "default") => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  // ── API instances ──────────────────────────────────────────────────────────
  const authApi = useMemo(() => new GatewayApi(DEFAULT_GATEWAY, {}), []);
  const api = useMemo(
    () => (accessToken.trim() ? new GatewayApi(DEFAULT_GATEWAY, { accessToken: accessToken.trim() }) : null),
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
        showToast("Command palette coming soon…");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showToast]);

  // ── Load API keys on navigate ──────────────────────────────────────────────
  useEffect(() => {
    if (currentPage === "api" && screen === "app" && accessToken) {
      const inst = new GatewayApi(DEFAULT_GATEWAY, { accessToken });
      void inst
        .listApiKeys()
        .then(setApiKeys)
        .catch((err: unknown) => {
          showToast(err instanceof Error ? err.message : "Failed to load API keys", "red");
        });
    }
  }, [currentPage, screen, accessToken, showToast]);

  // ── Auth ───────────────────────────────────────────────────────────────────

  const doLogin = () => {
    if (!loginEmail.trim()) {
      showToast("Please enter your email", "red");
      return;
    }
    setLoading(true);
    authApi
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
        setScreen("app");
        showToast("Welcome back! 👋", "green");
        // Pre-load tunnels
        const inst = new GatewayApi(DEFAULT_GATEWAY, { accessToken: result.accessToken });
        void inst.listTunnels().then(setTunnels).catch(() => {});
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
    authApi
      .register(regEmail.trim(), regPassword)
      .then((result) => {
        const displayName = [regFirstName.trim(), regLastName.trim()]
          .filter(Boolean)
          .join(" ");
        const initials =
          regFirstName && regLastName
            ? (regFirstName[0] + regLastName[0]).toUpperCase()
            : deriveInitials(result.user.email);
        setUser({
          email: result.user.email,
          name: displayName || deriveName(result.user.email),
          initials,
          role: result.user.role,
        });
        setAccessToken(result.accessToken);
        setSettingsName(regFirstName);
        setSettingsLastName(regLastName);
        showToast("Account created! Signing you in…", "green");
        setTimeout(() => setScreen("app"), 600);
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Registration failed", "red");
      })
      .finally(() => setLoading(false));
  };

  const doLogout = () => {
    setScreen("auth");
    setAccessToken("");
    setUser(null);
    setTunnels([]);
    setApiKeys([]);
    setCurrentPage("tunnels");
    setAiInsightVisible(true);
    showToast("Signed out successfully");
  };

  // ── Tunnels ────────────────────────────────────────────────────────────────

  const refreshTunnels = () => {
    const a = api;
    if (!a) return;
    setLoading(true);
    a.listTunnels()
      .then(setTunnels)
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to load tunnels", "red");
      })
      .finally(() => setLoading(false));
  };

  const createTunnel = () => {
    if (!newTunnelSubdomain.trim()) {
      showToast("Enter a subdomain", "red");
      return;
    }
    const a = api;
    if (!a) return;
    setLoading(true);
    a.createTunnel(newTunnelSubdomain.trim().toLowerCase())
      .then(() => {
        setNewTunnelSubdomain("");
        setShowNewTunnel(false);
        return a.listTunnels();
      })
      .then(setTunnels)
      .then(() => showToast("Tunnel created!", "green"))
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to create tunnel", "red");
      })
      .finally(() => setLoading(false));
  };

  const deleteTunnel = (id: string) => {
    const a = api;
    if (!a) return;
    setLoading(true);
    a.deleteTunnel(id)
      .then(() => a.listTunnels())
      .then(setTunnels)
      .then(() => showToast("Tunnel stopped", "green"))
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to stop tunnel", "red");
      })
      .finally(() => setLoading(false));
  };

  // ── API Keys ───────────────────────────────────────────────────────────────

  const loadApiKeys = () => {
    const a = api;
    if (!a) return;
    setLoading(true);
    a.listApiKeys()
      .then(setApiKeys)
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to load API keys", "red");
      })
      .finally(() => setLoading(false));
  };

  const createApiKey = () => {
    if (!newKeyName.trim()) {
      showToast("Enter a key name", "red");
      return;
    }
    const a = api;
    if (!a) return;
    setLoading(true);
    a.createApiKey(newKeyName.trim(), newKeyScopes.trim())
      .then((result) => {
        if (result.apiKey?.token) setCreatedKeyToken(result.apiKey.token);
        setNewKeyName("");
        setShowNewKey(false);
        return a.listApiKeys();
      })
      .then(setApiKeys)
      .then(() => showToast("API key generated!", "green"))
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to create key", "red");
      })
      .finally(() => setLoading(false));
  };

  const revokeApiKey = (id: string) => {
    const a = api;
    if (!a) return;
    setLoading(true);
    a.revokeApiKey(id)
      .then(() => a.listApiKeys())
      .then(setApiKeys)
      .then(() => showToast("API key revoked", "green"))
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Failed to revoke key", "red");
      })
      .finally(() => setLoading(false));
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── AUTH SCREEN ─────────────────────────────────────────────────── */}
      {screen === "auth" && (
        <AuthScreen
          authTab={authTab}
          setAuthTab={setAuthTab}
          theme={theme}
          setTheme={setThemeState}
          loginEmail={loginEmail}
          setLoginEmail={setLoginEmail}
          loginPassword={loginPassword}
          setLoginPassword={setLoginPassword}
          loginPassShow={loginPassShow}
          setLoginPassShow={setLoginPassShow}
          regFirstName={regFirstName}
          setRegFirstName={setRegFirstName}
          regLastName={regLastName}
          setRegLastName={setRegLastName}
          regEmail={regEmail}
          setRegEmail={setRegEmail}
          regOrg={regOrg}
          setRegOrg={setRegOrg}
          regPassword={regPassword}
          setRegPassword={setRegPassword}
          regPassShow={regPassShow}
          setRegPassShow={setRegPassShow}
          loading={loading}
          doLogin={doLogin}
          doRegister={doRegister}
        />
      )}

      {/* ── APP SCREEN ──────────────────────────────────────────────────── */}
      {screen === "app" && (
        <div id="screen-app" className="active">
          {/* ── Sidebar ─────────────────────────────────────────────────── */}
          <aside className="sidebar">
            <div className="logo">
              <div className="logo-icon">
                <i className="ti ti-topology-star" />
              </div>
              <span className="logo-wordmark">
                Portivox <span className="logo-badge">AI</span>
              </span>
            </div>

            <div className="nav-body">
              <span className="nav-group-label">Workspace</span>
              <div
                className={`nav-item ${currentPage === "tunnels" ? "active" : ""}`}
                onClick={() => setCurrentPage("tunnels")}
              >
                <i className="ti ti-topology-star-3" /> Tunnels
                {tunnels.length > 0 && (
                  <span className="nav-badge">{tunnels.length}</span>
                )}
              </div>
              <div
                className={`nav-item ${currentPage === "devices" ? "active" : ""}`}
                onClick={() => setCurrentPage("devices")}
              >
                <i className="ti ti-device-laptop" /> Devices
              </div>
              <div
                className={`nav-item ${currentPage === "ai" ? "active" : ""}`}
                onClick={() => setCurrentPage("ai")}
              >
                <i className="ti ti-sparkles" /> AI Assistant
              </div>

              <span className="nav-group-label">Analytics</span>
              <div
                className={`nav-item ${currentPage === "usage" ? "active" : ""}`}
                onClick={() => setCurrentPage("usage")}
              >
                <i className="ti ti-chart-bar" /> Usage
              </div>

              <span className="nav-group-label">Developer</span>
              <div
                className={`nav-item ${currentPage === "api" ? "active" : ""}`}
                onClick={() => setCurrentPage("api")}
              >
                <i className="ti ti-code" /> API Keys
              </div>

              <span className="nav-group-label">Account</span>
              <div
                className={`nav-item ${currentPage === "org" ? "active" : ""}`}
                onClick={() => setCurrentPage("org")}
              >
                <i className="ti ti-building" /> Organisation
              </div>
              <div
                className={`nav-item ${currentPage === "settings" ? "active" : ""}`}
                onClick={() => setCurrentPage("settings")}
              >
                <i className="ti ti-settings" /> Settings
              </div>
              <div
                className={`nav-item ${currentPage === "billing" ? "active" : ""}`}
                onClick={() => setCurrentPage("billing")}
              >
                <i className="ti ti-credit-card" /> Billing
              </div>
            </div>

            {/* Theme toggle */}
            <div className="theme-toggle-wrap">
              <div className="theme-toggle">
                <button
                  className={`theme-btn ${theme === "light" ? "active" : ""}`}
                  onClick={() => setThemeState("light")}
                >
                  <i className="ti ti-sun" /> Light
                </button>
                <button
                  className={`theme-btn ${theme === "dark" ? "active" : ""}`}
                  onClick={() => setThemeState("dark")}
                >
                  <i className="ti ti-moon" /> Dark
                </button>
              </div>
            </div>

            {/* User row */}
            <div className="user-row" onClick={() => setCurrentPage("settings")}>
              <div className="avatar">{user?.initials ?? "U"}</div>
              <div style={{ minWidth: 0 }}>
                <div className="user-name">{user?.name ?? "User"}</div>
                <div className="user-plan">
                  {user?.role === "owner"
                    ? "Owner"
                    : user?.role === "admin"
                      ? "Admin"
                      : "Member"}
                </div>
              </div>
              <i className="ti ti-chevron-right user-chevron" />
            </div>
          </aside>

          {/* ── Main area ───────────────────────────────────────────────── */}
          <div className="main">
            {/* Topbar */}
            <header className="topbar">
              <div className="topbar-left">
                <div className="breadcrumb">
                  <span className="breadcrumb-root">Portivox</span>
                  <span className="breadcrumb-sep">/</span>
                  <span className="breadcrumb-current">{PAGE_TITLES[currentPage]}</span>
                </div>
              </div>
              <div className="topbar-right">
                <div className="search-box">
                  <i className="ti ti-search" />
                  <span>Search…</span>
                  <span className="search-shortcut">⌘K</span>
                </div>
                <div className="notif-btn" title="Notifications">
                  <i className="ti ti-bell" />
                  <div className="notif-dot" />
                </div>
                <button className="ai-btn" onClick={() => setCurrentPage("ai")}>
                  <i className="ti ti-sparkles" /> Ask AI
                </button>
                <button className="logout-btn" onClick={doLogout}>
                  <i className="ti ti-logout" /> Log out
                </button>
              </div>
            </header>

            {/* Page content */}
            <div className="content">
              {currentPage === "tunnels" && (
                <TunnelsPage
                  tunnels={tunnels}
                  loading={loading}
                  aiInsightVisible={aiInsightVisible}
                  setAiInsightVisible={setAiInsightVisible}
                  onRefresh={refreshTunnels}
                  onNewTunnel={() => setShowNewTunnel(true)}
                  onDeleteTunnel={deleteTunnel}
                  onCopy={copyToClipboard}
                />
              )}
              {currentPage === "devices" && (
                <DevicesPage onCopy={copyToClipboard} />
              )}
              {currentPage === "ai" && <AiPage />}
              {currentPage === "usage" && <UsagePage tunnelCount={tunnels.length} />}
              {currentPage === "api" && (
                <ApiKeysPage
                  apiKeys={apiKeys}
                  loading={loading}
                  createdKeyToken={createdKeyToken}
                  onDismissToken={() => setCreatedKeyToken(null)}
                  onNewKey={() => setShowNewKey(true)}
                  onRevokeKey={revokeApiKey}
                  onCopy={copyToClipboard}
                  onRefresh={loadApiKeys}
                />
              )}
              {currentPage === "org" && <OrgPage user={user} />}
              {currentPage === "settings" && (
                <SettingsPage
                  user={user}
                  settingsName={settingsName}
                  setSettingsName={setSettingsName}
                  settingsLastName={settingsLastName}
                  setSettingsLastName={setSettingsLastName}
                  showToast={showToast}
                />
              )}
              {currentPage === "billing" && <BillingPage showToast={showToast} />}
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ──────────────────────────────────────────────────────── */}
      {showNewTunnel && (
        <NewTunnelModal
          subdomain={newTunnelSubdomain}
          setSubdomain={setNewTunnelSubdomain}
          loading={loading}
          onCreate={createTunnel}
          onClose={() => {
            setShowNewTunnel(false);
            setNewTunnelSubdomain("");
          }}
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
          onClose={() => {
            setShowNewKey(false);
            setNewKeyName("");
          }}
        />
      )}

      {/* ── Toast notifications ─────────────────────────────────────────── */}
      <div className="toast-wrap">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast${toast.type !== "default" ? ` ${toast.type}` : ""}`}
          >
            <i
              className={`ti ti-${
                toast.type === "green"
                  ? "check"
                  : toast.type === "red"
                    ? "alert-circle"
                    : "info-circle"
              }`}
            />
            {toast.message}
          </div>
        ))}
      </div>
    </>
  );
}
