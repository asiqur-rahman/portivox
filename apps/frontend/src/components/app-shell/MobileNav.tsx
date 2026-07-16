import { hasAdminRole } from "../../app/helpers";
import type { Page, UserInfo } from "../../app/types";

interface MobileBottomNavProps {
  currentPage: Page;
  mobileMoreOpen: boolean;
  onNavigate: (page: Page) => void;
  onToggleMore: () => void;
}

export function MobileBottomNav({
  currentPage,
  mobileMoreOpen,
  onNavigate,
  onToggleMore,
}: MobileBottomNavProps) {
  return (
    <nav className="mobile-bottom-nav">
      {[
        { page: "tunnels" as Page, label: "Sessions", icon: "topology-star-3" },
        { page: "api" as Page, label: "API", icon: "key" },
        { page: "inspector" as Page, label: "Inspector", icon: "scan-eye" },
      ].map((item) => (
        <button
          key={item.page}
          className={`mobile-bottom-item ${currentPage === item.page ? "active" : ""}`}
          onClick={() => onNavigate(item.page)}
        >
          <i className={`ti ti-${item.icon}`} />
          <span>{item.label}</span>
        </button>
      ))}
      <button
        className={`mobile-bottom-item ${mobileMoreOpen || !["tunnels", "api", "inspector"].includes(currentPage) ? "active" : ""}`}
        onClick={onToggleMore}
      >
        <i className="ti ti-dots" />
        <span>More</span>
      </button>
    </nav>
  );
}

interface MobileMoreSheetProps {
  currentPage: Page;
  user: UserInfo | null;
  open: boolean;
  onClose: () => void;
  onNavigate: (page: Page) => void;
}

export function MobileMoreSheet({
  currentPage,
  user,
  open,
  onClose,
  onNavigate,
}: MobileMoreSheetProps) {
  if (!open) return null;

  return (
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <div className="mobile-more-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="mobile-sheet-handle" />
        <div className="mobile-sheet-head">
          <div>
            <div className="mobile-sheet-title">More</div>
            <div className="mobile-sheet-sub">{user?.name ?? "Portivox workspace"}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close menu">
            <i className="ti ti-x" />
          </button>
        </div>
        <div className="mobile-sheet-grid">
          {[
            { page: "devices" as Page, label: "Devices", icon: "device-laptop" },
            { page: "usage" as Page, label: "Usage", icon: "chart-bar" },
            { page: "org" as Page, label: "Organisation", icon: "building" },
            { page: "billing" as Page, label: "Billing", icon: "credit-card" },
            { page: "settings" as Page, label: "Account", icon: "user-cog" },
          ].map((item) => (
            <button
              key={item.page}
              className={`mobile-sheet-item ${currentPage === item.page ? "active" : ""}`}
              onClick={() => onNavigate(item.page)}
            >
              <i className={`ti ti-${item.icon}`} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        {hasAdminRole(user?.role) && (
          <>
            <div className="mobile-sheet-section">Administration</div>
            <div className="mobile-sheet-grid">
              {[
                { page: "admin:overview" as Page, label: "Overview", icon: "layout-dashboard" },
                { page: "admin:audit" as Page, label: "Audit", icon: "clipboard-list" },
                { page: "admin:gateway" as Page, label: "Gateway", icon: "server-cog" },
                { page: "admin:tcp" as Page, label: "TCP Ports", icon: "network" },
                { page: "admin:users" as Page, label: "Users", icon: "users" },
              ].map((item) => (
                <button
                  key={item.page}
                  className={`mobile-sheet-item ${currentPage === item.page ? "active" : ""}`}
                  onClick={() => onNavigate(item.page)}
                >
                  <i className={`ti ti-${item.icon}`} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
