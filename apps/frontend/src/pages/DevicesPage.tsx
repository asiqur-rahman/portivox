import type { UserInfo } from "../app/types";
import { getWsGatewayUrl } from "../app/helpers";

export function DevicesPage({ user, onCopy }: { user: UserInfo | null; onCopy: (text: string) => void }) {
  const wsUrl = getWsGatewayUrl();
  const installCmd = "npm install -g portivox-client";
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
                No registration needed, connect from anywhere.
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
              1 - Install the CLI
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
              2 - Open a tunnel
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
                3 - Use an API key for automation
              </p>
              <p style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>
                Generate a key in <strong>API Keys</strong>, then replace{" "}
                <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>tk_YOUR_API_KEY</code>.
              </p>
              <div className="code-block">
                <code>{openWithKeyCmd}</code>
                <div className="icon-btn" style={{ color: "#b4a9ff" }} onClick={() => onCopy(openWithKeyCmd)} title="Copy">
                  <i className="ti ti-copy" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
