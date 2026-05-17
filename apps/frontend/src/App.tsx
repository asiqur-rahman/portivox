import { useMemo, useState } from "react";
import { GatewayApi, type ApiKeyRecord, type AuditItem, type ChunkDiagnostics, type TunnelRecord } from "./api";
import "./styles.css";

const DEFAULT_GATEWAY = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "http://localhost:8080";

type ViewTab = "customer" | "admin";

export function App() {
  const [tab, setTab] = useState<ViewTab>("customer");
  const [gatewayUrl, setGatewayUrl] = useState(DEFAULT_GATEWAY);
  const [apiKey, setApiKey] = useState("");

  const [subdomain, setSubdomain] = useState("");
  const [tunnels, setTunnels] = useState<TunnelRecord[]>([]);

  const [newKeyName, setNewKeyName] = useState("frontend-key");
  const [newKeyScopes, setNewKeyScopes] = useState("tunnel:create,tunnel:read,tunnel:delete,key:manage");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [diagnostics, setDiagnostics] = useState<ChunkDiagnostics | null>(null);
  const [ready, setReady] = useState<{ ready: boolean; draining: boolean; maintenanceMode: boolean; activeTunnels: number } | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const api = useMemo(() => {
    if (!apiKey.trim()) return null;
    return new GatewayApi(gatewayUrl.replace(/\/$/, ""), apiKey.trim());
  }, [gatewayUrl, apiKey]);

  const withRun = async (fn: () => Promise<void>): Promise<void> => {
    if (!api) {
      setError("Enter API key first.");
      return;
    }
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const refreshTunnels = async (): Promise<void> => {
    await withRun(async () => {
      const rows = await api!.listTunnels();
      setTunnels(rows);
      setStatus(`Loaded ${rows.length} tunnel(s).`);
    });
  };

  const createTunnel = async (): Promise<void> => {
    if (!subdomain.trim()) {
      setError("Enter a subdomain.");
      return;
    }
    await withRun(async () => {
      await api!.createTunnel(subdomain.trim().toLowerCase());
      setSubdomain("");
      const rows = await api!.listTunnels();
      setTunnels(rows);
      setStatus("Tunnel created.");
    });
  };

  const deleteTunnel = async (id: string): Promise<void> => {
    await withRun(async () => {
      await api!.deleteTunnel(id);
      setTunnels(await api!.listTunnels());
      setStatus("Tunnel deleted.");
    });
  };

  const loadAdminOverview = async (): Promise<void> => {
    await withRun(async () => {
      const [readyz, chunkStats, keyRows, auditRows] = await Promise.all([
        api!.getReadyz(),
        api!.getChunkDiagnostics(),
        api!.listApiKeys(),
        api!.getAudit(20),
      ]);
      setReady(readyz);
      setDiagnostics(chunkStats);
      setKeys(keyRows);
      setAudit(auditRows);
      setStatus("Admin overview loaded.");
    });
  };

  const createKey = async (): Promise<void> => {
    if (!newKeyName.trim()) {
      setError("Enter key name.");
      return;
    }
    await withRun(async () => {
      const created = await api!.createApiKey(newKeyName.trim(), newKeyScopes.trim());
      setCreatedToken(created.token ?? null);
      setKeys(await api!.listApiKeys());
      setStatus("API key created.");
    });
  };

  const revokeKey = async (id: string): Promise<void> => {
    await withRun(async () => {
      await api!.revokeApiKey(id);
      setKeys(await api!.listApiKeys());
      setStatus("API key revoked.");
    });
  };

  const setAdminState = async (patch: { maintenanceMode?: boolean; draining?: boolean }): Promise<void> => {
    await withRun(async () => {
      const next = await api!.setAdminState(patch);
      setReady((prev) => ({
        ready: prev?.ready ?? true,
        activeTunnels: prev?.activeTunnels ?? 0,
        ...next,
      }));
      setStatus("Admin state updated.");
    });
  };

  return (
    <main className="container">
      <h1>Portivox Console</h1>
      <p className="muted">Customer + Admin management UI</p>

      <section className="card">
        <h2>Gateway Access</h2>
        <label>
          Gateway URL
          <input value={gatewayUrl} onChange={(event) => setGatewayUrl(event.target.value)} placeholder="http://localhost:8080" />
        </label>
        <label>
          API Key
          <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="tk_xxx" type="password" />
        </label>
        <div className="row">
          <button disabled={loading || !apiKey.trim()} onClick={() => void refreshTunnels()}>Load Customer Data</button>
          <button disabled={loading || !apiKey.trim()} onClick={() => void loadAdminOverview()}>Load Admin Data</button>
        </div>
      </section>

      <section className="card">
        <h2>View</h2>
        <div className="row">
          <button className={tab === "customer" ? "active" : ""} onClick={() => setTab("customer")}>Customer</button>
          <button className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}>Admin</button>
        </div>
      </section>

      {tab === "customer" ? (
        <>
          <section className="card">
            <h2>Create Session/Tunnel</h2>
            <label>
              Requested Subdomain
              <input value={subdomain} onChange={(event) => setSubdomain(event.target.value)} placeholder="myapp" />
            </label>
            <button disabled={loading || !apiKey.trim()} onClick={() => void createTunnel()}>Create</button>
          </section>

          <section className="card">
            <h2>Your Sessions</h2>
            {tunnels.length === 0 ? <p className="muted">No active sessions.</p> : (
              <table>
                <thead>
                  <tr><th>Subdomain</th><th>Connection URL</th><th>Created</th><th>Action</th></tr>
                </thead>
                <tbody>
                  {tunnels.map((tunnel) => (
                    <tr key={tunnel.id}>
                      <td>{tunnel.subdomain}</td>
                      <td>{`http://${tunnel.subdomain}.app.localtest.me`}</td>
                      <td>{new Date(tunnel.createdAt).toLocaleString()}</td>
                      <td><button className="danger" disabled={loading} onClick={() => void deleteTunnel(tunnel.id)}>Delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="card">
            <h2>System State</h2>
            <p className="muted">ready: {String(ready?.ready ?? "unknown")}, draining: {String(ready?.draining ?? "unknown")}, maintenance: {String(ready?.maintenanceMode ?? "unknown")}, activeTunnels: {ready?.activeTunnels ?? "unknown"}</p>
            <div className="row">
              <button disabled={loading} onClick={() => void setAdminState({ maintenanceMode: true })}>Enable Maintenance</button>
              <button disabled={loading} onClick={() => void setAdminState({ maintenanceMode: false, draining: false })}>Disable Maintenance</button>
              <button disabled={loading} onClick={() => void setAdminState({ draining: true })}>Enable Drain</button>
              <button disabled={loading} onClick={() => void setAdminState({ draining: false })}>Disable Drain</button>
            </div>
          </section>

          <section className="card">
            <h2>API Key Management</h2>
            <label>
              Name
              <input value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} />
            </label>
            <label>
              Scopes (comma separated)
              <input value={newKeyScopes} onChange={(event) => setNewKeyScopes(event.target.value)} />
            </label>
            <div className="row">
              <button disabled={loading} onClick={() => void createKey()}>Create API Key</button>
              <button disabled={loading} onClick={() => void loadAdminOverview()}>Refresh</button>
            </div>
            {createdToken ? <p className="status">New token (copy now): {createdToken}</p> : null}

            {keys.length === 0 ? <p className="muted">No keys found.</p> : (
              <table>
                <thead><tr><th>Name</th><th>Scopes</th><th>Created</th><th>Revoked</th><th>Action</th></tr></thead>
                <tbody>
                  {keys.map((keyRow) => (
                    <tr key={keyRow.id}>
                      <td>{keyRow.name}</td>
                      <td>{keyRow.scopes.join(",")}</td>
                      <td>{new Date(keyRow.createdAt).toLocaleString()}</td>
                      <td>{String(keyRow.revoked)}</td>
                      <td><button className="danger" disabled={loading || keyRow.revoked} onClick={() => void revokeKey(keyRow.id)}>Revoke</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h2>Chunk Diagnostics</h2>
            <p className="muted">frames: {diagnostics?.chunkFramesReceived ?? 0}, reassembled: {diagnostics?.chunkStreamsReassembled ?? 0}, incompleteTimeouts: {diagnostics?.chunkIncompleteTimeouts ?? 0}</p>
          </section>

          <section className="card">
            <h2>Recent Audit Events</h2>
            {audit.length === 0 ? <p className="muted">No audit entries.</p> : (
              <table>
                <thead><tr><th>Time</th><th>Action</th><th>User</th><th>Resource</th></tr></thead>
                <tbody>
                  {audit.map((item) => (
                    <tr key={item.id}>
                      <td>{new Date(item.createdAt).toLocaleString()}</td>
                      <td>{item.action}</td>
                      <td>{item.userId ?? "system"}</td>
                      <td>{item.resource}{item.resourceId ? `:${item.resourceId}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {status ? <p className="status">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
