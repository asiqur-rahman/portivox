import { useCallback, useEffect, useMemo, useState } from "react";
import { GatewayApi, type ApiKeyRecord, type TunnelRecord } from "./api";
import { DEFAULT_GATEWAY } from "./app/constants";
import { hasAdminRole } from "./app/helpers";
import { subscribeGatewayLiveEvents } from "./app/live-events";
import type { ConfirmState, Page } from "./app/types";
import { AppFooter } from "./components/app-shell/AppFooter";
import { AppSidebar } from "./components/app-shell/AppSidebar";
import { AppTopbar } from "./components/app-shell/AppTopbar";
import { BootSplash } from "./components/app-shell/BootSplash";
import { MobileBottomNav, MobileMoreSheet } from "./components/app-shell/MobileNav";
import { ToastStack } from "./components/app-shell/ToastStack";
import { useGatewayStatus } from "./hooks/useGatewayStatus";
import { useInstallPrompt } from "./hooks/useInstallPrompt";
import { useTheme } from "./hooks/useTheme";
import { useToasts } from "./hooks/useToasts";
import { useAuthFlow } from "./hooks/useAuthFlow";
import { useTunnelActions } from "./hooks/useTunnelActions";
import { useApiKeyActions } from "./hooks/useApiKeyActions";
import { useRealtimeGatewayEvents } from "./hooks/useRealtimeGatewayEvents";
import { ConfirmModal as SharedConfirmModal, GlobalSearchModal as SharedGlobalSearchModal, type GlobalSearchItem, InstallPromptModal as SharedInstallPromptModal, NewKeyModal as SharedNewKeyModal, NewTunnelModal as SharedNewTunnelModal } from "./components/modals";
import { ApiKeysPage as SharedApiKeysPage } from "./pages/ApiKeysPage";
import { AdminAuditPage as SharedAdminAuditPage } from "./pages/AdminAuditPage";
import { AdminGatewayPage as SharedAdminGatewayPage } from "./pages/AdminGatewayPage";
import { AdminOverviewPage as SharedAdminOverviewPage } from "./pages/AdminOverviewPage";
import { AdminTcpPage as SharedAdminTcpPage } from "./pages/AdminTcpPage";
import { AuthScreen as SharedAuthScreen } from "./pages/AuthScreen";
import { BillingPage as SharedBillingPage } from "./pages/BillingPage";
import { DevicesPage as SharedDevicesPage } from "./pages/DevicesPage";
import { OrgPage as SharedOrgPage } from "./pages/OrgPage";
import { SettingsPage as SharedSettingsPage } from "./pages/SettingsPage";
import { TunnelsPage as SharedTunnelsPage } from "./pages/TunnelsPage";
import { UsagePage as SharedUsagePage } from "./pages/UsagePage";
import { InspectorPage as SharedInspectorPage } from "./pages/InspectorPage";
import "./styles.css";
export function App() {
  const { theme, setTheme: setThemeState } = useTheme();

  const [currentPage, setCurrentPage] = useState<Page>("tunnels");
  const [inspectorSubdomain, setInspectorSubdomain] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentSearchIds, setRecentSearchIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("ptx-recent-searches");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string").slice(0, 6) : [];
    } catch {
      return [];
    }
  });

  const [tunnels, setTunnels] = useState<TunnelRecord[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [aiInsightVisible, setAiInsightVisible] = useState(true);

  const [showNewTunnel, setShowNewTunnel] = useState(false);
  const [newTunnelSubdomain, setNewTunnelSubdomain] = useState("");
  const [showNewKey, setShowNewKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(["tunnel:create", "tunnel:read", "tunnel:delete"]);
  const [createdKeyToken, setCreatedKeyToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const { toasts, showToast } = useToasts();
  const {
    appReady,
    screen,
    isAnonymous,
    authTab,
    setAuthTab,
    user,
    accessToken,
    loginEmail,
    setLoginEmail,
    loginPassword,
    setLoginPassword,
    loginPassShow,
    setLoginPassShow,
    regFirstName,
    setRegFirstName,
    regLastName,
    setRegLastName,
    regEmail,
    setRegEmail,
    regPassword,
    setRegPassword,
    regPassShow,
    setRegPassShow,
    doLogin,
    doRegister,
    doLogout,
  } = useAuthFlow({
    setTunnels,
    setApiKeys,
    setAiInsightVisible,
    setLoading,
    setCurrentPage,
    showToast,
  });
  const gatewayStatus = useGatewayStatus(screen);
  const { canInstallDirectly, shouldShowInstallPrompt, dismissInstallPrompt, triggerInstallPrompt } = useInstallPrompt({ appReady });

  const api = useMemo(
    () => new GatewayApi(DEFAULT_GATEWAY, accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
    [accessToken],
  );

  const copyToClipboard = useCallback(
    (text: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => showToast("Copied to clipboard!"))
        .catch(() => showToast("Copy failed", "red"));
    },
    [showToast],
  );

  useEffect(() => {
    setMobileNavOpen(false);
    setMobileMoreOpen(false);
  }, [currentPage, screen]);

  useEffect(() => {
    if (screen !== "app") return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingContext =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }

      if (!searchOpen && !isTypingContext && event.key === "/") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [screen, searchOpen]);

  const navigateToPage = useCallback((page: Page) => {
    if (page === "inspector") {
      setInspectorSubdomain(null);
    }
    setCurrentPage(page);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);
  const clearRecentSearches = useCallback(() => {
    setRecentSearchIds([]);
    try {
      localStorage.removeItem("ptx-recent-searches");
    } catch {
      // ignore
    }
  }, []);
  const registerRecentSearch = useCallback((itemId: string) => {
    setRecentSearchIds((previous) => {
      const next = [itemId, ...previous.filter((value) => value !== itemId)].slice(0, 6);
      try {
        localStorage.setItem("ptx-recent-searches", JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
  const createSearchAction = useCallback((itemId: string, action: () => void) => {
    return () => {
      registerRecentSearch(itemId);
      action();
    };
  }, [registerRecentSearch]);
  const { refreshTunnels, createTunnel, requestDeleteTunnel } = useTunnelActions({
    api,
    newTunnelSubdomain,
    setLoading,
    setTunnels,
    setNewTunnelSubdomain,
    setShowNewTunnel,
    setConfirm,
    showToast,
  });

  const { loadApiKeys, createApiKey, requestRevokeKey } = useApiKeyActions({
    api,
    newKeyName,
    newKeyScopes,
    setLoading,
    setApiKeys,
    setCreatedKeyToken,
    setNewKeyName,
    setShowNewKey,
    setConfirm,
    showToast,
  });

  useRealtimeGatewayEvents({ api, screen });

  const searchCatalogItems = useMemo<GlobalSearchItem[]>(() => {
    const pageItems: GlobalSearchItem[] = [
      { id: "page:tunnels", title: "Tunnels", subtitle: "Manage live, reserved, and offline tunnels", category: "Pages", icon: "ti-topology-star-3", onSelect: createSearchAction("page:tunnels", () => navigateToPage("tunnels")) },
      { id: "page:devices", title: "Devices", subtitle: "Install and connect client machines", category: "Pages", icon: "ti-device-laptop", onSelect: createSearchAction("page:devices", () => navigateToPage("devices")) },
      { id: "page:usage", title: "Usage & Logs", subtitle: "Review activity and recent events", category: "Pages", icon: "ti-chart-bar", onSelect: createSearchAction("page:usage", () => navigateToPage("usage")) },
      { id: "page:api", title: "API Keys", subtitle: "Manage automation and CLI access", category: "Pages", icon: "ti-code", onSelect: createSearchAction("page:api", () => navigateToPage("api")) },
      { id: "page:inspector", title: "Traffic Inspector", subtitle: "Inspect captured HTTP requests", category: "Pages", icon: "ti-eye", onSelect: createSearchAction("page:inspector", () => navigateToPage("inspector")) },
      { id: "page:org", title: "Organisation", subtitle: "View workspace ownership details", category: "Pages", icon: "ti-building", onSelect: createSearchAction("page:org", () => navigateToPage("org")) },
      { id: "page:settings", title: "Settings", subtitle: "Manage account and security settings", category: "Pages", icon: "ti-settings", onSelect: createSearchAction("page:settings", () => navigateToPage("settings")) },
      { id: "page:billing", title: "Billing", subtitle: "Review billing and invoice placeholders", category: "Pages", icon: "ti-credit-card", onSelect: createSearchAction("page:billing", () => navigateToPage("billing")) },
    ];

    const adminItems: GlobalSearchItem[] = hasAdminRole(user?.role)
      ? [
          { id: "page:admin-overview", title: "Admin Overview", subtitle: "Gateway operations summary", category: "Admin pages", icon: "ti-layout-dashboard", onSelect: createSearchAction("page:admin-overview", () => navigateToPage("admin:overview")) },
          { id: "page:admin-audit", title: "Audit Log", subtitle: "Review gateway and account events", category: "Admin pages", icon: "ti-clipboard-list", onSelect: createSearchAction("page:admin-audit", () => navigateToPage("admin:audit")) },
          { id: "page:admin-gateway", title: "Gateway Control", subtitle: "Operate maintenance, drain, and sessions", category: "Admin pages", icon: "ti-server-cog", onSelect: createSearchAction("page:admin-gateway", () => navigateToPage("admin:gateway")) },
          { id: "page:admin-tcp", title: "TCP Port Mappings", subtitle: "Manage reserved TCP public ports", category: "Admin pages", icon: "ti-network", onSelect: createSearchAction("page:admin-tcp", () => navigateToPage("admin:tcp")) },
        ]
      : [];

    const actionItems: GlobalSearchItem[] = [
      { id: "action:new-tunnel", title: "New tunnel", subtitle: "Reserve a new subdomain from the dashboard", category: "Quick actions", icon: "ti-plus", onSelect: createSearchAction("action:new-tunnel", () => setShowNewTunnel(true)) },
      { id: "action:new-api-key", title: "Generate API key", subtitle: "Create a new CLI or automation credential", category: "Quick actions", icon: "ti-key", onSelect: createSearchAction("action:new-api-key", () => { setCurrentPage("api"); setShowNewKey(true); }) },
      { id: "action:refresh-tunnels", title: "Refresh tunnels", subtitle: "Reload the latest tunnel session data", category: "Quick actions", icon: "ti-refresh", onSelect: createSearchAction("action:refresh-tunnels", () => void refreshTunnels()) },
    ];

    const tunnelItems: GlobalSearchItem[] = tunnels.map((tunnel) => ({
      id: `tunnel:${tunnel.id}`,
      title: tunnel.subdomain,
      subtitle: tunnel.statusMessage ?? (tunnel.active ? "Tunnel is online" : "Tunnel is currently offline"),
      category: "Tunnels",
      icon: tunnel.status === "offline" ? "ti-plug-x" : tunnel.status === "reserved" ? "ti-clock-hour-4" : "ti-world",
      onSelect: createSearchAction(`tunnel:${tunnel.id}`, () => navigateToPage("tunnels")),
    }));

    const apiKeyItems: GlobalSearchItem[] = apiKeys.map((key) => ({
      id: `api-key:${key.id}`,
      title: key.name,
      subtitle: key.scopes.join(" / ") || "No scopes assigned",
      category: "API keys",
      icon: "ti-key",
      onSelect: createSearchAction(`api-key:${key.id}`, () => navigateToPage("api")),
    }));

    return [...actionItems, ...pageItems, ...adminItems, ...tunnelItems, ...apiKeyItems];
  }, [apiKeys, createSearchAction, navigateToPage, refreshTunnels, tunnels, user?.role]);

  const filteredSearchItems = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const recentSearchItems = recentSearchIds
      .map((id) => searchCatalogItems.find((item) => item.id === id))
      .filter((item): item is GlobalSearchItem => Boolean(item))
      .map((item) => ({ ...item, category: "Recent searches" }));

    if (!normalizedQuery) {
      const priorityItems = [
        ...recentSearchItems,
        ...searchCatalogItems.filter((item) => item.category === "Quick actions").slice(0, 3),
        ...searchCatalogItems.filter((item) => item.category === "Pages").slice(0, 5),
      ];

      const deduped = priorityItems.filter((item, index, collection) => collection.findIndex((candidate) => candidate.id === item.id) === index);
      return deduped.slice(0, 12);
    }

    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

    return searchCatalogItems
      .map((item) => {
        const haystack = `${item.title} ${item.subtitle ?? ""} ${item.category}`.toLowerCase();
        const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
        return { item, score, startsWith: haystack.startsWith(normalizedQuery) || item.title.toLowerCase().startsWith(normalizedQuery) };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (left.startsWith !== right.startsWith) {
          return left.startsWith ? -1 : 1;
        }
        return right.score - left.score || left.item.title.localeCompare(right.item.title);
      })
      .slice(0, 12)
      .map((entry) => entry.item);
  }, [recentSearchIds, searchCatalogItems, searchQuery]);

  useEffect(() => {
    if (currentPage !== "api" || screen !== "app") return;
    loadApiKeys();
  }, [currentPage, screen, loadApiKeys]);

  useEffect(() => {
    if (screen !== "app") {
      return;
    }

    let tunnelTimer: ReturnType<typeof setTimeout> | null = null;
    let apiKeyTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = subscribeGatewayLiveEvents((event) => {
      if (event.kind === "tunnels_changed") {
        if (tunnelTimer) {
          clearTimeout(tunnelTimer);
        }
        tunnelTimer = setTimeout(() => {
          tunnelTimer = null;
          refreshTunnels({ silent: true });
        }, 150);
      }

      if (event.kind === "api_keys_changed") {
        if (apiKeyTimer) {
          clearTimeout(apiKeyTimer);
        }
        apiKeyTimer = setTimeout(() => {
          apiKeyTimer = null;
          loadApiKeys({ silent: true });
        }, 150);
      }
    });

    return () => {
      unsubscribe();
      if (tunnelTimer) {
        clearTimeout(tunnelTimer);
      }
      if (apiKeyTimer) {
        clearTimeout(apiKeyTimer);
      }
    };
  }, [loadApiKeys, refreshTunnels, screen]);

  // ── Boot splash ────────────────────────────────────────────────────────────
  if (!appReady) {
    return <BootSplash />;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── AUTH SCREEN ──────────────────────────────────────────────────── */}
      {screen === "auth" && (
        <SharedAuthScreen
          authTab={authTab} setAuthTab={setAuthTab}
          theme={theme} setTheme={setThemeState}
          loginEmail={loginEmail} setLoginEmail={setLoginEmail}
          loginPassword={loginPassword} setLoginPassword={setLoginPassword}
          loginPassShow={loginPassShow} setLoginPassShow={setLoginPassShow}
          regFirstName={regFirstName} setRegFirstName={setRegFirstName}
          regLastName={regLastName} setRegLastName={setRegLastName}
          regEmail={regEmail} setRegEmail={setRegEmail}
          regPassword={regPassword} setRegPassword={setRegPassword}
          regPassShow={regPassShow} setRegPassShow={setRegPassShow}
          loading={loading} doLogin={doLogin} doRegister={doRegister}
        />
      )}

      {/* ── APP SCREEN ───────────────────────────────────────────────────── */}
      {screen === "app" && (
        <div id="screen-app" className="active">
          {/* ── Sidebar ──────────────────────────────────────────────────── */}
          <AppSidebar
            currentPage={currentPage}
            tunnels={tunnels}
            mobileNavOpen={mobileNavOpen}
            theme={theme}
            user={user}
            isAnonymous={isAnonymous}
            onNavigate={navigateToPage}
            onThemeChange={setThemeState}
          />

          {/* ── Main ─────────────────────────────────────────────────────── */}
          <div className="main">
            <AppTopbar
              currentPage={currentPage}
              mobileNavOpen={mobileNavOpen}
              gatewayStatus={gatewayStatus}
              onOpenSearch={() => setSearchOpen(true)}
              onToggleMobileNav={() => setMobileNavOpen((prev) => !prev)}
              onNavigate={navigateToPage}
              onLogout={doLogout}
            />

            {mobileNavOpen && <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} />}

            <div className="content">
              <div className="content-inner">
              {currentPage === "tunnels" && (
                <SharedTunnelsPage
                  tunnels={tunnels}
                  loading={loading}
                  gatewayStatus={gatewayStatus}
                  aiInsightVisible={aiInsightVisible}
                  setAiInsightVisible={setAiInsightVisible}
                  onRefresh={refreshTunnels}
                  onNewTunnel={() => setShowNewTunnel(true)}
                  onDeleteTunnel={requestDeleteTunnel}
                  onCopy={copyToClipboard}
                  onInspect={(sub) => { setInspectorSubdomain(sub); setCurrentPage("inspector"); }}
                />
              )}
              {currentPage === "devices" && (
                <SharedDevicesPage user={user} onCopy={copyToClipboard} />
              )}
              {currentPage === "usage" && (
                <SharedUsagePage api={api} tunnelCount={tunnels.length} />
              )}
              {currentPage === "api" && (
                <SharedApiKeysPage
                  apiKeys={apiKeys}
                  loading={loading}
                  createdKeyToken={createdKeyToken}
                  onDismissToken={() => setCreatedKeyToken(null)}
                  onNewKey={() => setShowNewKey(true)}
                  onRevokeKey={requestRevokeKey}
                  onCopy={copyToClipboard}
                  onRefresh={loadApiKeys}
                />
              )}
              {currentPage === "org" && <SharedOrgPage user={user} />}
              {currentPage === "settings" && (
                <SharedSettingsPage
                  user={user}
                  isAnonymous={isAnonymous}
                  api={api}
                  showToast={showToast}
                  onLogout={doLogout}
                />
              )}
              {currentPage === "billing" && <SharedBillingPage showToast={showToast} />}

              {/* ── Admin pages ── */}
              {currentPage === "admin:overview" && hasAdminRole(user?.role) && (
                <SharedAdminOverviewPage api={api} showToast={showToast} />
              )}
              {currentPage === "admin:audit" && hasAdminRole(user?.role) && (
                <SharedAdminAuditPage api={api} showToast={showToast} />
              )}
              {currentPage === "admin:gateway" && hasAdminRole(user?.role) && (
                <SharedAdminGatewayPage
                  api={api}
                  tunnels={tunnels}
                  showToast={showToast}
                  onConfirm={setConfirm}
                />
              )}
              {currentPage === "admin:tcp" && hasAdminRole(user?.role) && (
                <SharedAdminTcpPage api={api} showToast={showToast} onConfirm={setConfirm} />
              )}
              {currentPage === "inspector" && (
                <SharedInspectorPage
                  api={api}
                  tunnels={tunnels}
                  initialSubdomain={inspectorSubdomain}
                  onBack={() => navigateToPage("tunnels")}
                />
              )}
              </div>
            </div>

            <MobileBottomNav
              currentPage={currentPage}
              mobileMoreOpen={mobileMoreOpen}
              onNavigate={navigateToPage}
              onToggleMore={() => setMobileMoreOpen((prev) => !prev)}
            />

            <MobileMoreSheet
              currentPage={currentPage}
              user={user}
              open={mobileMoreOpen}
              onClose={() => setMobileMoreOpen(false)}
              onNavigate={navigateToPage}
            />

            <AppFooter />
          </div>
        </div>
      )}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {showNewTunnel && (
        <SharedNewTunnelModal
          subdomain={newTunnelSubdomain}
          setSubdomain={setNewTunnelSubdomain}
          loading={loading}
          onCreate={createTunnel}
          onClose={() => { setShowNewTunnel(false); setNewTunnelSubdomain(""); }}
        />
      )}
      {showNewKey && (
        <SharedNewKeyModal
          name={newKeyName}
          setName={setNewKeyName}
          scopes={newKeyScopes}
          setScopes={setNewKeyScopes}
          loading={loading}
          onCreate={createApiKey}
          onClose={() => { setShowNewKey(false); setNewKeyName(""); setNewKeyScopes(["tunnel:create", "tunnel:read", "tunnel:delete"]); }}
        />
      )}
      {confirm && (
        <SharedConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
      <SharedGlobalSearchModal
        open={searchOpen}
        query={searchQuery}
        setQuery={setSearchQuery}
        items={filteredSearchItems}
        onClearRecent={clearRecentSearches}
        onClose={closeSearch}
      />

      {/* ── Toasts ────────────────────────────────────────────────────────── */}
      {shouldShowInstallPrompt && (
        <SharedInstallPromptModal
          canInstallDirectly={canInstallDirectly}
          onInstall={triggerInstallPrompt}
          onDismiss={dismissInstallPrompt}
        />
      )}
      <ToastStack toasts={toasts} />
    </>
  );
}









