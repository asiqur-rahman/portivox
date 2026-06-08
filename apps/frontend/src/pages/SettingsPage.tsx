import { useCallback, useState } from "react";
import { GatewayApi } from "../api";
import type { Toast, UserInfo } from "../app/types";
import { ConfirmModal } from "../components/modals";

export function SettingsPage({
  user,
  isAnonymous,
  api,
  showToast,
  onLogout,
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
  const accountLabel = isAnonymous ? "Anonymous access" : "Authenticated account";
  const protectionLabel = isAnonymous ? "Authentication disabled" : "Account protected";

  const saveDisplayName = () => {
    try {
      const raw = localStorage.getItem("ptx-session");
      if (raw) {
        const session = JSON.parse(raw) as Record<string, unknown>;
        session.name = displayName;
        localStorage.setItem("ptx-session", JSON.stringify(session));
      }
    } catch {
      // ignore
    }
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
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to change password", "red");
      })
      .finally(() => setPassLoading(false));
  }, [api, confirmPass, curPass, newPass, showToast]);

  return (
    <div className="page">
      <div className="section settings-overview-card">
        <div className="settings-overview-grid">
          <div className="settings-overview-main">
            <div className="settings-overview-kicker">Account</div>
            <div className="settings-overview-name">{displayName || user?.name || "Anonymous"}</div>
            <div className="settings-overview-meta">
              <span>{user?.email ?? "No email available"}</span>
              <span className="settings-overview-divider">•</span>
              <span>{accountLabel}</span>
            </div>
          </div>
          <div className="settings-overview-side">
            <div className="settings-overview-chip">
              <i className={`ti ti-${isAnonymous ? "shield-off" : "shield-check"}`} />
              {protectionLabel}
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-user-circle" /> Profile</div>
        </div>
        <div className="form-body">
          <div className="settings-section-copy">
            Manage how this account appears inside the dashboard on this device.
          </div>
          <div className="form-field">
            <label className="form-lbl">Display name</label>
            <input
              type="text"
              className="form-inp"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && saveDisplayName()}
              placeholder="How your name appears in the dashboard"
            />
            <p style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 5 }}>
              This preference is stored locally in your browser.
            </p>
          </div>
          <div className="form-field">
            <label className="form-lbl">Email address</label>
            <input type="email" className="form-inp" value={user?.email ?? ""} disabled />
          </div>
          <button className="btn-save form-action-btn" onClick={saveDisplayName}>
            <i className="ti ti-check" /> Save name
          </button>
        </div>
      </div>

      {!isAnonymous ? (
        <div className="section">
          <div className="section-head">
            <div className="section-title"><i className="ti ti-lock" /> Security</div>
          </div>
          <div className="form-body">
            <div className="settings-section-copy">
              Update the password used to sign in to this Portivox account.
            </div>
            <div className="form-field">
              <label className="form-lbl">Current password</label>
              <input type="password" className="form-inp" value={curPass} onChange={(event) => setCurPass(event.target.value)} placeholder="........" />
            </div>
            <div className="form-field">
              <label className="form-lbl">New password</label>
              <input type="password" className="form-inp" value={newPass} onChange={(event) => setNewPass(event.target.value)} placeholder="Minimum 8 characters" />
            </div>
            <div className="form-field">
              <label className="form-lbl">Confirm new password</label>
              <input
                type="password"
                className="form-inp"
                value={confirmPass}
                onChange={(event) => setConfirmPass(event.target.value)}
                placeholder="Repeat new password"
                onKeyDown={(event) => event.key === "Enter" && doChangePassword()}
              />
            </div>
            <button className="btn-save form-action-btn" disabled={passLoading} onClick={doChangePassword}>
              {passLoading ? <><i className="ti ti-loader-2 spin" /> Saving...</> : <><i className="ti ti-check" /> Change password</>}
            </button>
          </div>
        </div>
      ) : (
        <div className="section">
          <div className="form-body">
            <div className="settings-readonly-note">
              <i className="ti ti-info-circle" />
              <div>
                <strong>Password controls are unavailable</strong>
                <span>
                  This gateway is running with <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>AUTH_REQUIRED=false</code>. Anonymous access is enabled, so account password management is intentionally unavailable here.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="section" style={{ borderColor: "rgba(225,112,85,0.25)" }}>
        <div className="section-head">
          <div className="section-title" style={{ color: "var(--red)" }}>
            <i className="ti ti-alert-triangle" style={{ color: "var(--red)" }} /> Danger zone
          </div>
        </div>
        <div className="settings-danger-row">
          <div className="settings-danger-copy">
            <div className="settings-danger-title">End current session</div>
            <div className="settings-danger-desc">
              Sign out from this browser session. Existing tunnels continue running until they are stopped separately.
            </div>
          </div>
          <button className="btn-danger" onClick={onLogout}>
            <i className="ti ti-logout" /> Sign out
          </button>
        </div>
        {!isAnonymous && (
          <div className="settings-danger-row settings-danger-row-bordered">
            <div className="settings-danger-copy">
              <div className="settings-danger-title">Delete account</div>
              <div className="settings-danger-desc">
                Permanently remove this account from the self-hosted Portivox instance.
              </div>
            </div>
            <button className="btn-danger btn-danger-muted" onClick={() => setShowDeleteConfirm(true)}>
              Delete account
            </button>
          </div>
        )}
      </div>

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete account?"
          message="Account deletion is an operator-level action on a self-hosted deployment. Remove the user directly from the instance database, or wipe the environment entirely if this installation is disposable."
          confirmLabel="I understand"
          onConfirm={() => setShowDeleteConfirm(false)}
          onClose={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
