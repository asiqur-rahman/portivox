import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { GatewayApi, type ApiKeyRecord, type TunnelRecord } from "../api";
import { DEFAULT_GATEWAY } from "../app/constants";
import { deriveInitials, deriveName } from "../app/helpers";
import { clearSession, loadSession, saveSession } from "../app/session";
import type { AuthTab, Page, UserInfo } from "../app/types";

interface UseAuthFlowOptions {
  setTunnels: Dispatch<SetStateAction<TunnelRecord[]>>;
  setApiKeys: Dispatch<SetStateAction<ApiKeyRecord[]>>;
  setAiInsightVisible: Dispatch<SetStateAction<boolean>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setCurrentPage: Dispatch<SetStateAction<Page>>;
  showToast: (message: string, type?: "default" | "green" | "red") => void;
}

export function useAuthFlow({
  setTunnels,
  setApiKeys,
  setAiInsightVisible,
  setLoading,
  setCurrentPage,
  showToast,
}: UseAuthFlowOptions) {
  const [appReady, setAppReady] = useState(false);
  const [screen, setScreen] = useState<"auth" | "app">("auth");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [authTab, setAuthTab] = useState<AuthTab>("login");

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginPassShow, setLoginPassShow] = useState(false);
  const [regFirstName, setRegFirstName] = useState("");
  const [regLastName, setRegLastName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regPassShow, setRegPassShow] = useState(false);

  const [user, setUser] = useState<UserInfo | null>(null);
  const [accessToken, setAccessToken] = useState("");

  useEffect(() => {
    function enterApp(token: string, userInfo: UserInfo, anonymous: boolean, initialTunnels: TunnelRecord[]) {
      setAccessToken(token);
      setUser(userInfo);
      setIsAnonymous(anonymous);
      setTunnels(initialTunnels);
      setScreen("app");
      setAppReady(true);
    }

    function tryAnonymous() {
      const anonymousApi = new GatewayApi(DEFAULT_GATEWAY, {});
      anonymousApi
        .listTunnels()
        .then((tunnels) => {
          enterApp("", { email: "local@anonymous", name: "Anonymous", initials: "AN", role: "admin" }, true, tunnels);
        })
        .catch(() => {
          setScreen("auth");
          setAppReady(true);
        });
    }

    const session = loadSession();
    if (session) {
      const api = new GatewayApi(DEFAULT_GATEWAY, { accessToken: session.token });
      api
        .listTunnels()
        .then((tunnels) => {
          enterApp(session.token, session.user, false, tunnels);
        })
        .catch(() => {
          clearSession();
          tryAnonymous();
        });
    } else {
      tryAnonymous();
    }
  }, [setTunnels]);

  const doLogin = useCallback(() => {
    if (!loginEmail.trim()) {
      showToast("Please enter your email", "red");
      return;
    }

    setLoading(true);
    new GatewayApi(DEFAULT_GATEWAY, {})
      .login(loginEmail.trim(), loginPassword)
      .then((result) => {
        const info: UserInfo = {
          email: result.user.email,
          name: deriveName(result.user.email),
          initials: deriveInitials(result.user.email),
          role: result.user.role,
        };

        setUser(info);
        setAccessToken(result.accessToken);
        setIsAnonymous(false);
        saveSession(result.accessToken, info);
        showToast("Welcome back! 👋", "green");

        const api = new GatewayApi(DEFAULT_GATEWAY, { accessToken: result.accessToken });
        void api.listTunnels().then(setTunnels).catch(() => {});
        setScreen("app");
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Login failed", "red");
      })
      .finally(() => setLoading(false));
  }, [loginEmail, loginPassword, setLoading, setTunnels, showToast]);

  const doRegister = useCallback(() => {
    if (!regEmail.trim() || !regPassword.trim()) {
      showToast("Please fill in email and password", "red");
      return;
    }

    setLoading(true);
    new GatewayApi(DEFAULT_GATEWAY, {})
      .register(regEmail.trim(), regPassword)
      .then((result) => {
        const displayName = [regFirstName.trim(), regLastName.trim()].filter(Boolean).join(" ");
        const initials =
          regFirstName && regLastName
            ? (regFirstName[0] + regLastName[0]).toUpperCase()
            : deriveInitials(result.user.email);

        const info: UserInfo = {
          email: result.user.email,
          name: displayName || deriveName(result.user.email),
          initials,
          role: result.user.role,
        };

        setUser(info);
        setAccessToken(result.accessToken);
        setIsAnonymous(false);
        saveSession(result.accessToken, info);
        showToast("Account created! Welcome 🎉", "green");
        setTimeout(() => setScreen("app"), 400);
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "Registration failed", "red");
      })
      .finally(() => setLoading(false));
  }, [regEmail, regFirstName, regLastName, regPassword, setLoading, showToast]);

  const doLogout = useCallback(() => {
    clearSession();
    setAccessToken("");
    setUser(null);
    setIsAnonymous(false);
    setTunnels([]);
    setApiKeys([]);
    setCurrentPage("tunnels");
    setAiInsightVisible(true);
    setLoginEmail("");
    setLoginPassword("");
    setRegEmail("");
    setRegPassword("");
    setRegFirstName("");
    setRegLastName("");
    setScreen("auth");
    showToast("Signed out");
  }, [setAiInsightVisible, setApiKeys, setCurrentPage, setTunnels, showToast]);

  return {
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
  };
}
