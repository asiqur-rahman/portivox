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
import { ConfirmModal as SharedConfirmModal, InstallPromptModal as SharedInstallPromptModal, NewKeyModal as SharedNewKeyModal, NewTunnelModal as SharedNewTunnelModal } from "./components/modals";
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

  const navigateToPage = useCallback((page: Page) => {
    if (page === "inspector") {
      setInspectorSubdomain(null);
    }
    setCurrentPage(page);
  }, []);
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








