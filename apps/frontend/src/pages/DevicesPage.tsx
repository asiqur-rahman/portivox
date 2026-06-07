import type { UserInfo } from "../app/types";

export function DevicesPage({ user, onCopy }: { user: UserInfo | null; onCopy: (text: string) => void }) {
  const installCmd = "npm install -g portivox-client";
  const registerCmd = "portivox register tk_YOUR_API_KEY";
  const openCmd = "portivox open 3000";

  return (
    <div className="page">
      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-device-laptop" /> CLI installation</div>
        </div>
        <div style={{ padding: "18px 22px", display: "grid", gap: 20 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.65 }}>
            Install the Portivox client on the target machine, register the API key once, then open the local port you want to expose.
          </p>
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>
              Install client
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
              Register API key
            </p>
            <div className="code-block">
              <code>{registerCmd}</code>
              <div className="icon-btn" style={{ color: "#b4a9ff" }} onClick={() => onCopy(registerCmd)} title="Copy">
                <i className="ti ti-copy" />
              </div>
            </div>
          </div>
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>
              Open tunnel
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
                Automation
              </p>
              <p style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>
                Generate a dedicated key in <strong>API Keys</strong> when you need CI, scripts, or unattended device setup.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
