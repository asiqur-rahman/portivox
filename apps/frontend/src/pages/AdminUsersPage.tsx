import { useCallback, useEffect, useState } from "react";
import { GatewayApi, type AdminUser } from "../api";
import { timeAgo } from "../app/helpers";
import type { Toast } from "../app/types";
import { useLiveRefresh } from "../hooks/useLiveRefresh";

export function AdminUsersPage({
  api,
  showToast,
}: {
  api: GatewayApi;
  showToast: (msg: string, type?: Toast["type"]) => void;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const refresh = useCallback((options?: { silent?: boolean }) => {
    setLoading(true);
    api.listUsers()
      .then(setUsers)
      .catch((error: unknown) => {
        if (!options?.silent) {
          showToast(error instanceof Error ? error.message : "Load failed", "red");
        }
      })
      .finally(() => setLoading(false));
  }, [api, showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useLiveRefresh({
    eventKinds: ["users_changed"],
    refresh: () => refresh({ silent: true }),
  });

  function toggleSubdomain(user: AdminUser, enabled: boolean) {
    setSavingId(user.id);
    api.setUserSubdomainEnabled(user.id, enabled)
      .then((updated) => {
        setUsers((previous) => previous.map((u) => (u.id === updated.id ? updated : u)));
        showToast(
          `Subdomain access ${enabled ? "enabled" : "disabled"} for ${user.email}`,
          "green",
        );
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Update failed", "red"))
      .finally(() => setSavingId(null));
  }

  return (
    <div className="page-body">
      <div className="admin-hero">
        <div className="admin-hero-left">
          <div className="admin-hero-title"><i className="ti ti-users" />Users &amp; subscriptions<span className="admin-hero-badge">Access</span></div>
          <div className="admin-hero-sub">Grant the subdomain feature to subscribed users. Everyone else gets a dedicated public port only.</div>
        </div>
        <div className="admin-hero-right">
          <button className="btn-ghost btn-ghost-on-dark" onClick={() => refresh()} disabled={loading}>
            <i className={`ti ti-refresh${loading ? " spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-list" /> {users.length} user{users.length !== 1 ? "s" : ""}</div>
        </div>

        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-3)" }}>
            <i className="ti ti-loader-2 spin" style={{ fontSize: 22, display: "block", marginBottom: 8 }} />
            Loading users...
          </div>
        ) : users.length === 0 ? (
          <div className="empty">
            <i className="ti ti-user-off" />
            <div className="empty-title">No registered users</div>
            <div className="empty-desc">
              Users appear here after they register on the console. You can then enable the subdomain
              feature per user; without it their HTTP tunnels are exposed on a dedicated public port only.
            </div>
          </div>
        ) : (
          <>
            <div className="mobile-card-list">
              {users.map((user) => (
                <article key={user.id} className="mobile-list-card">
                  <div className="mobile-list-card-head">
                    <div className="mobile-list-title">
                      <span className="mobile-list-icon"><i className="ti ti-user" /></span>
                      <div>
                        <strong>{user.email}</strong>
                        <span>{timeAgo(user.createdAt)}</span>
                      </div>
                    </div>
                    <span className={`mobile-status ${user.subdomainEnabled ? "live" : ""}`}>{user.subdomainEnabled ? "Subdomain" : "Port only"}</span>
                  </div>
                  <div className="mobile-card-actions">
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={user.subdomainEnabled}
                        disabled={savingId === user.id}
                        onChange={(event) => toggleSubdomain(user, event.target.checked)}
                      />
                      <span className="toggle-track" />
                    </label>
                    <span style={{ color: "var(--text-3)", fontSize: 12 }}>Subdomain feature</span>
                  </div>
                </article>
              ))}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Access</th>
                  <th>Registered</th>
                  <th>Subdomain feature</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td style={{ fontWeight: 600, color: "var(--text-1)" }}>{user.email}</td>
                    <td>
                      <span className={`action-badge ${user.subdomainEnabled ? "create" : "other"}`}>
                        <i className={`ti ti-${user.subdomainEnabled ? "world" : "plug"}`} />
                        {user.subdomainEnabled ? "Subdomain + port" : "Port only"}
                      </span>
                    </td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{timeAgo(user.createdAt)}</td>
                    <td>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={user.subdomainEnabled}
                          disabled={savingId === user.id}
                          onChange={(event) => toggleSubdomain(user, event.target.checked)}
                        />
                        <span className="toggle-track" />
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
