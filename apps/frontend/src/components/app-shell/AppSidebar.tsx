import { PAGE_TITLES } from "../../app/constants";
import { hasAdminRole } from "../../app/helpers";
import type { Page, Theme, UserInfo } from "../../app/types";
import type { TunnelRecord } from "../../api";

interface AppSidebarProps {
  currentPage: Page;
  tunnels: TunnelRecord[];
  mobileNavOpen: boolean;
  theme: Theme;
  user: UserInfo | null;
  isAnonymous: boolean;
  onNavigate: (page: Page) => void;
  onThemeChange: (theme: Theme) => void;
}

export function AppSidebar({
  currentPage,
  tunnels,
  mobileNavOpen,
  theme,
  user,
  isAnonymous,
  onNavigate,
  onThemeChange,
}: AppSidebarProps) {
  const activeTunnelCount = tunnels.filter((tunnel) => tunnel.active).length;

  return (
    <aside className={`sidebar ${mobileNavOpen ? "mobile-open" : ""}`}>
      <div className="logo">
        <div className="logo-icon"><i className="ti ti-topology-star" /></div>
        <span className="logo-wordmark">Portivox <span className="logo-badge">AI</span></span>
      </div>

      <div className="nav-body">
        <span className="nav-group-label">Workspace</span>
        {(["tunnels", "devices", "ai"] as Page[]).map((page) => (
          <div key={page} className={`nav-item ${currentPage === page ? "active" : ""}`} onClick={() => onNavigate(page)}>
            <i className={`ti ti-${page === "tunnels" ? "topology-star-3" : page === "devices" ? "device-laptop" : "sparkles"}`} />
            {PAGE_TITLES[page]}
            {page === "tunnels" && activeTunnelCount > 0 && <span className="nav-badge">{activeTunnelCount}</span>}
          </div>
        ))}

        <span className="nav-group-label">Analytics</span>
        <div className={`nav-item ${currentPage === "usage" ? "active" : ""}`} onClick={() => onNavigate("usage")}>
          <i className="ti ti-chart-bar" /> {PAGE_TITLES.usage}
        </div>

        <span className="nav-group-label">Developer</span>
        <div className={`nav-item ${currentPage === "api" ? "active" : ""}`} onClick={() => onNavigate("api")}>
          <i className="ti ti-code" /> {PAGE_TITLES.api}
        </div>
        <div className={`nav-item ${currentPage === "inspector" ? "active" : ""}`} onClick={() => onNavigate("inspector")}>
          <i className="ti ti-eye" /> {PAGE_TITLES.inspector}
        </div>

        <span className="nav-group-label">Account</span>
        {(["org", "settings", "billing"] as Page[]).map((page) => (
          <div key={page} className={`nav-item ${currentPage === page ? "active" : ""}`} onClick={() => onNavigate(page)}>
            <i className={`ti ti-${page === "org" ? "building" : page === "settings" ? "settings" : "credit-card"}`} />
            {PAGE_TITLES[page]}
          </div>
        ))}

        {hasAdminRole(user?.role) && (
          <>
            <span className="nav-admin-label">
              <span className="nav-admin-dot" />
              Administration
            </span>
            <div className={`nav-item ${currentPage === "admin:overview" ? "active" : ""}`} onClick={() => onNavigate("admin:overview")}>
              <i className="ti ti-layout-dashboard" /> Overview
              <span className="nav-admin-badge">Admin</span>
            </div>
            <div className={`nav-item ${currentPage === "admin:audit" ? "active" : ""}`} onClick={() => onNavigate("admin:audit")}>
              <i className="ti ti-clipboard-list" /> Audit Log
            </div>
            <div className={`nav-item ${currentPage === "admin:gateway" ? "active" : ""}`} onClick={() => onNavigate("admin:gateway")}>
              <i className="ti ti-server-cog" /> Gateway
            </div>
            <div className={`nav-item ${currentPage === "admin:tcp" ? "active" : ""}`} onClick={() => onNavigate("admin:tcp")}>
              <i className="ti ti-network" /> TCP Ports
            </div>
          </>
        )}
      </div>

      <div className="theme-toggle-wrap">
        <div className="theme-toggle">
          <button className={`theme-btn ${theme === "light" ? "active" : ""}`} onClick={() => onThemeChange("light")}>
            <i className="ti ti-sun" /> Light
          </button>
          <button className={`theme-btn ${theme === "dark" ? "active" : ""}`} onClick={() => onThemeChange("dark")}>
            <i className="ti ti-moon" /> Dark
          </button>
        </div>
      </div>

      <div className="user-row" onClick={() => onNavigate("settings")}>
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
  );
}
