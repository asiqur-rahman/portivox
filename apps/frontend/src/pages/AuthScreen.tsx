import type { AuthTab, Theme } from "../app/types";

export function AuthScreen({
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
  regPassword,
  setRegPassword,
  regPassShow,
  setRegPassShow,
  loading,
  doLogin,
  doRegister,
}: {
  authTab: AuthTab;
  setAuthTab: (tab: AuthTab) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  loginEmail: string;
  setLoginEmail: (value: string) => void;
  loginPassword: string;
  setLoginPassword: (value: string) => void;
  loginPassShow: boolean;
  setLoginPassShow: (value: boolean) => void;
  regFirstName: string;
  setRegFirstName: (value: string) => void;
  regLastName: string;
  setRegLastName: (value: string) => void;
  regEmail: string;
  setRegEmail: (value: string) => void;
  regPassword: string;
  setRegPassword: (value: string) => void;
  regPassShow: boolean;
  setRegPassShow: (value: boolean) => void;
  loading: boolean;
  doLogin: () => void;
  doRegister: () => void;
}) {
  return (
    <div id="screen-auth">
      <div className="auth-left">
        <div className="auth-left-inner">
          <div className="auth-brand">
            <div className="auth-brand-icon"><i className="ti ti-topology-star" /></div>
            <span className="auth-brand-name">Portivox</span>
          </div>
          <h1 className="auth-headline">Secure tunnels.<br /><em>Built for real systems.</em></h1>
          <p className="auth-sub">
            Expose local ports to the internet in seconds with reliable connectivity,
            clean operational visibility, and production-ready tunnel management.
          </p>
          <div className="auth-features">
            <div className="auth-feature">
              <div className="auth-feature-dot"><i className="ti ti-shield-lock" /></div>
              <span>End-to-end encrypted WebSocket tunnels</span>
            </div>
            <div className="auth-feature">
              <div className="auth-feature-dot"><i className="ti ti-sparkles" /></div>
              <span>Operational diagnostics and live tunnel insights</span>
            </div>
            <div className="auth-feature">
              <div className="auth-feature-dot"><i className="ti ti-clock" /></div>
              <span>Up in seconds with no config needed</span>
            </div>
            <div className="auth-feature">
              <div className="auth-feature-dot"><i className="ti ti-building" /></div>
              <span>Team and enterprise org management</span>
            </div>
          </div>
        </div>
      </div>

      <div className="auth-right">
        <div className="auth-theme-top">
          <div className="theme-toggle" style={{ width: "fit-content" }}>
            <button className={`theme-btn ${theme === "light" ? "active" : ""}`} onClick={() => setTheme("light")}><i className="ti ti-sun" /></button>
            <button className={`theme-btn ${theme === "dark" ? "active" : ""}`} onClick={() => setTheme("dark")}><i className="ti ti-moon" /></button>
          </div>
        </div>

        <div className="auth-tabs">
          <button data-testid="auth-tab-login" className={`auth-tab ${authTab === "login" ? "active" : ""}`} onClick={() => setAuthTab("login")}>Sign in</button>
          <button data-testid="auth-tab-register" className={`auth-tab ${authTab === "register" ? "active" : ""}`} onClick={() => setAuthTab("register")}>Create account</button>
        </div>

        <div className={`auth-panel ${authTab === "login" ? "active" : ""}`}>
          <div className="auth-form-title">Welcome back</div>
          <div className="auth-form-sub">Sign in to your Portivox workspace</div>
          <div className="auth-form">
            <div>
              <label className="field-label" htmlFor="login-email">Email address</label>
              <input
                className="field-input"
                id="login-email"
                data-testid="login-email"
                type="email"
                placeholder="you@company.com"
                autoComplete="email"
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && doLogin()}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="login-pass">Password</label>
              <div className="field-input-wrap">
                <input
                  className="field-input"
                  id="login-pass"
                  data-testid="login-password"
                  type={loginPassShow ? "text" : "password"}
                  placeholder="........"
                  autoComplete="current-password"
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && doLogin()}
                />
                <i className={`ti ${loginPassShow ? "ti-eye-off" : "ti-eye"} field-eye`} onClick={() => setLoginPassShow(!loginPassShow)} />
              </div>
            </div>
            <button data-testid="login-submit" className="auth-submit" disabled={loading} onClick={doLogin}>
              {loading ? <><i className="ti ti-loader-2 spin" /> Signing in...</> : <><i className="ti ti-login" /> Sign in</>}
            </button>
          </div>
          <div className="auth-footer-note">
            Don&apos;t have an account?{" "}
            <a href="#" onClick={(event) => { event.preventDefault(); setAuthTab("register"); }}>Create one free -&gt;</a>
          </div>
        </div>

        <div className={`auth-panel ${authTab === "register" ? "active" : ""}`}>
          <div className="auth-form-title">Create your account</div>
          <div className="auth-form-sub">Get started free with no credit card required</div>
          <div className="auth-form">
            <div className="field-row">
              <div>
                <label className="field-label">First name</label>
                <input data-testid="register-first-name" className="field-input" type="text" placeholder="First name" value={regFirstName} onChange={(event) => setRegFirstName(event.target.value)} />
              </div>
              <div>
                <label className="field-label">Last name</label>
                <input data-testid="register-last-name" className="field-input" type="text" placeholder="Last name" value={regLastName} onChange={(event) => setRegLastName(event.target.value)} />
              </div>
            </div>
            <div>
              <label className="field-label">Work email</label>
              <input data-testid="register-email" className="field-input" type="email" placeholder="you@company.com" value={regEmail} onChange={(event) => setRegEmail(event.target.value)} />
            </div>
            <div>
              <label className="field-label">Password</label>
              <div className="field-input-wrap">
                <input
                  className="field-input"
                  data-testid="register-password"
                  type={regPassShow ? "text" : "password"}
                  placeholder="Min. 8 characters"
                  value={regPassword}
                  onChange={(event) => setRegPassword(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && doRegister()}
                />
                <i className={`ti ${regPassShow ? "ti-eye-off" : "ti-eye"} field-eye`} onClick={() => setRegPassShow(!regPassShow)} />
              </div>
            </div>
            <button data-testid="register-submit" className="auth-submit" disabled={loading} onClick={doRegister}>
              {loading ? <><i className="ti ti-loader-2 spin" /> Creating account...</> : <><i className="ti ti-user-plus" /> Create account</>}
            </button>
          </div>
          <div className="auth-footer-note">
            Already have an account?{" "}
            <a href="#" onClick={(event) => { event.preventDefault(); setAuthTab("login"); }}>Sign in -&gt;</a>
          </div>
        </div>
      </div>
    </div>
  );
}
