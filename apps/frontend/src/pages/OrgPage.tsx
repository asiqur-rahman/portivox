import { useState } from "react";
import type { UserInfo } from "../app/types";

export function OrgPage({ user }: { user: UserInfo | null }) {
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
              Self-hosted instance - {user ? "1 member" : "-"}
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-users" /> Members</div>
          <button className="btn-ghost" onClick={() => setShowInviteNote((value) => !value)}>
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
                  In self-hosted mode, additional users can sign up directly with the <strong>Create Account</strong> form.
                  Full invitations, role management, and SSO are planned later.
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
