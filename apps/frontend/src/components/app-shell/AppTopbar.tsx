import { PAGE_TITLES } from "../../app/constants";
import { isAdminPage } from "../../app/helpers";
import type { Page } from "../../app/types";
import type { GatewayStatus } from "../../api";

interface AppTopbarProps {
  currentPage: Page;
  mobileNavOpen: boolean;
  gatewayStatus: GatewayStatus | null;
  onToggleMobileNav: () => void;
  onNavigate: (page: Page) => void;
  onLogout: () => void;
}

export function AppTopbar({
  currentPage,
  mobileNavOpen,
  gatewayStatus,
  onToggleMobileNav,
  onNavigate,
  onLogout,
}: AppTopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="mobile-menu-btn"
          onClick={onToggleMobileNav}
          aria-label={mobileNavOpen ? "Close navigation menu" : "Open navigation menu"}
        >
          <i className={`ti ti-${mobileNavOpen ? "x" : "menu-2"}`} />
        </button>
        <div className="breadcrumb">
          <span className="breadcrumb-root">Portivox</span>
          <span className="breadcrumb-sep">/</span>
          {isAdminPage(currentPage) && (
            <>
              <span className="breadcrumb-root breadcrumb-admin-link" onClick={() => onNavigate("admin:overview")}>
                Admin
              </span>
              <span className="breadcrumb-sep">/</span>
            </>
          )}
          <span className="breadcrumb-current">{PAGE_TITLES[currentPage]}</span>
        </div>
      </div>
      <div className="topbar-right">
        <div className="search-box" aria-hidden="true">
          <i className="ti ti-search" />
          <span>Search tunnels, logs, and settings...</span>
          <span className="search-shortcut">Ctrl+K</span>
        </div>
        <div
          className={`notif-btn ${gatewayStatus?.ready ? "notif-btn-ready" : ""}`}
          title={gatewayStatus?.ready ? "Gateway healthy" : "Gateway status unknown"}
        >
          <i className={`ti ti-${gatewayStatus?.ready ? "circle-check" : "circle-dashed"}`} />
        </div>
        <button className="logout-btn" onClick={onLogout}>
          <i className="ti ti-logout" /> Log out
        </button>
      </div>
    </header>
  );
}
