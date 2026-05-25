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
      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-user-circle" /> Profile</div>
        </div>
        <div className="form-body">
          <div className="form-field">
            <label className="form-lbl">Display name</label>
            <input
              type="text"
              className="form-inp"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && saveDisplayName()}
            />
            <p style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 5 }}>Stored locally in your browser.</p>
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
            <div className="section-title"><i className="ti ti-lock" /> Change password</div>
          </div>
          <div className="form-body">
            <div className="form-field">
              <label className="form-lbl">Current password</label>
              <input type="password" className="form-inp" value={curPass} onChange={(event) => setCurPass(event.target.value)} placeholder="........" />
            </div>
            <div className="form-field">
              <label className="form-lbl">New password</label>
              <input type="password" className="form-inp" value={newPass} onChange={(event) => setNewPass(event.target.value)} placeholder="Min. 8 characters" />
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
          <div style={{ padding: "18px 22px" }}>
            <div className="ai-insight">
              <div className="ai-badge"><i className="ti ti-info-circle" /></div>
              <div style={{ flex: 1 }}>
                <div className="ai-insight-label">Auth disabled</div>
                <div className="ai-insight-text">
                  This gateway is running with <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>AUTH_REQUIRED=false</code>.
                  Password management is not available in anonymous mode.
                </div>
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
            <div className="settings-danger-title">Sign out</div>
            <div className="settings-danger-desc">
              Sign out of this session. Your tunnels will remain active.
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
                Remove your user account from this self-hosted instance.
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
          message={`Account deletion requires direct database access on a self-hosted instance. Connect to the PostgreSQL database and run: DELETE FROM "User" WHERE email = 'your@email.com'; or use docker compose down -v to wipe all data.`}
          confirmLabel="I understand"
          onConfirm={() => setShowDeleteConfirm(false)}
          onClose={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
