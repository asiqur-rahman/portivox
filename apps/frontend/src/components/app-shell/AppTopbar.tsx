import { PAGE_TITLES } from "../../app/constants";
import { isAdminPage } from "../../app/helpers";
import type { Page } from "../../app/types";
import type { GatewayStatus } from "../../api";

interface AppTopbarProps {
  currentPage: Page;
  mobileNavOpen: boolean;
  gatewayStatus: GatewayStatus | null;
  onOpenSearch: () => void;
  onToggleMobileNav: () => void;
  onNavigate: (page: Page) => void;
  onLogout: () => void;
}

export function AppTopbar({
  currentPage,
  mobileNavOpen,
  gatewayStatus,
  onOpenSearch,
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
        <button
          type="button"
          className="search-box"
          onClick={onOpenSearch}
          title="Search pages, tunnels, and actions"
          aria-label="Open global search"
        >
          <i className="ti ti-search" />
          <span className="search-box-text">Search pages, tunnels, and actions</span>
          <span className="search-shortcut">Ctrl+K /</span>
        </button>
        <button
          type="button"
          className="notif-btn topbar-search-btn"
          onClick={onOpenSearch}
          title="Search"
          aria-label="Open global search"
        >
          <i className="ti ti-search" />
        </button>
        <div
          className={`notif-btn gateway-status-pill ${gatewayStatus?.ready ? "notif-btn-ready" : ""}`}
          title={gatewayStatus?.ready ? "Gateway healthy" : "Gateway state unavailable"}
          aria-label={gatewayStatus?.ready ? "Gateway healthy" : "Gateway state unavailable"}
        >
          <i className={`ti ti-${gatewayStatus?.ready ? "circle-check" : "circle-dashed"}`} />
          <span className="gateway-status-text">{gatewayStatus?.ready ? "Gateway healthy" : "Gateway offline"}</span>
        </div>
        <button className="logout-btn" onClick={onLogout}>
          <i className="ti ti-logout" />
          <span className="logout-btn-text">Log out</span>
        </button>
      </div>
    </header>
  );
}
