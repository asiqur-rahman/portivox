import { useCallback, useEffect, useState } from "react";
import { GatewayApi, type TcpPortMapping } from "../api";
import { timeAgo } from "../app/helpers";
import type { Toast } from "../app/types";
import { useLiveRefresh } from "../hooks/useLiveRefresh";

function NewTcpMappingModal({
  onCreate,
  onClose,
}: {
  onCreate: (data: { name: string; localPort: number; publicPort: number; description?: string }, onDone: () => void) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [publicPort, setPublicPort] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  function submit() {
    const local = parseInt(localPort, 10);
    const publicValue = parseInt(publicPort, 10);
    if (!name.trim() || !local || !publicValue) return;
    setSaving(true);
    onCreate(
      { name: name.trim(), localPort: local, publicPort: publicValue, description: description.trim() || undefined },
      () => setSaving(false),
    );
  }

  return (
      <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title"><i className="ti ti-network" /> Reserve TCP port</div>
          <div className="icon-btn" onClick={onClose}><i className="ti ti-x" /></div>
        </div>
        <div className="modal-body" style={{ display: "grid", gap: 14 }}>
          <div>
            <label className="form-lbl">Mapping name <span style={{ color: "var(--red)" }}>*</span></label>
            <input className="form-inp" placeholder="e.g. Production Postgres" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </div>
          <div className="responsive-two-col-grid" style={{ display: "grid", gap: 12 }}>
            <div>
              <label className="form-lbl">Target port <span style={{ color: "var(--red)" }}>*</span></label>
              <input className="form-inp" type="number" min={1} max={65535} placeholder="5432" value={localPort} onChange={(event) => setLocalPort(event.target.value)} />
            </div>
            <div>
              <label className="form-lbl">Public port <span style={{ color: "var(--red)" }}>*</span></label>
              <input className="form-inp" type="number" min={1} max={65535} placeholder="19000" value={publicPort} onChange={(event) => setPublicPort(event.target.value)} />
            </div>
          </div>
          <div>
            <label className="form-lbl">Operational note</label>
            <input className="form-inp" placeholder="Optional description for your team" value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving || !name.trim() || !localPort || !publicPort} onClick={submit}>
            {saving ? <><i className="ti ti-loader-2 spin" /> Reserving...</> : <><i className="ti ti-plus" /> Reserve mapping</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AdminTcpPage({
  api,
  showToast,
  onConfirm,
}: {
  api: GatewayApi;
  showToast: (msg: string, type?: Toast["type"]) => void;
  onConfirm: (state: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void;
}) {
  const [mappings, setMappings] = useState<TcpPortMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback((options?: { silent?: boolean }) => {
    setLoading(true);
    api.listTcpPortMappings()
      .then(setMappings)
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
    eventKinds: ["tcp_mappings_changed"],
    refresh: () => refresh({ silent: true }),
  });

  function handleCreate(data: { name: string; localPort: number; publicPort: number; description?: string }, onDone: () => void) {
    api.createTcpPortMapping(data)
      .then((mapping) => {
        setMappings((previous) => [mapping, ...previous]);
        setShowCreate(false);
        showToast(`TCP mapping "${mapping.name}" reserved`, "green");
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Create failed", "red");
        onDone();
      });
  }

  function requestDelete(id: string, name: string) {
    onConfirm({
      title: "Delete TCP mapping?",
      message: `This will permanently remove "${name}". Any clients using this public port will lose connectivity.`,
      confirmLabel: "Delete mapping",
      danger: true,
      onConfirm: () => {
        api.deleteTcpPortMapping(id)
          .then(() => {
            setMappings((previous) => previous.filter((mapping) => mapping.id !== id));
            showToast("Mapping deleted", "green");
          })
          .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Delete failed", "red"));
      },
    });
  }

  return (
    <div className="page-body">
      <div className="admin-hero">
        <div className="admin-hero-left">
          <div className="admin-hero-title"><i className="ti ti-network" />TCP port reservations<span className="admin-hero-badge">Operations</span></div>
          <div className="admin-hero-sub">Reserve public TCP entry points for SSH, databases, and other direct service traffic.</div>
        </div>
        <div className="admin-hero-right">
          <button className="btn-ghost btn-ghost-on-dark" onClick={() => refresh()} disabled={loading}>
            <i className={`ti ti-refresh${loading ? " spin" : ""}`} />
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <i className="ti ti-plus" /> Reserve port
          </button>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-list" /> {mappings.length} reservation{mappings.length !== 1 ? "s" : ""}</div>
        </div>

        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-3)" }}>
            <i className="ti ti-loader-2 spin" style={{ fontSize: 22, display: "block", marginBottom: 8 }} />
            Loading TCP reservations...
          </div>
        ) : mappings.length === 0 ? (
          <div className="empty">
            <i className="ti ti-network-off" />
            <div className="empty-title">No reserved TCP ports</div>
            <div className="empty-desc">
              Reserve a public port to keep a stable TCP entry point ready for a client service.
              The gateway will forward traffic from that public port to the target port on the connected machine.
            </div>
            <button className="btn-primary empty-cta-btn" onClick={() => setShowCreate(true)}>
              <span className="btn-icon-wrap"><i className="ti ti-plus" /></span>
              <span className="btn-label">Reserve port</span>
            </button>
          </div>
        ) : (
          <>
            <div className="mobile-card-list">
              {mappings.map((mapping) => (
                <article key={mapping.id} className="mobile-list-card">
                  <div className="mobile-list-card-head">
                    <div className="mobile-list-title">
                      <span className="mobile-list-icon"><i className="ti ti-network" /></span>
                      <div>
                        <strong>{mapping.name}</strong>
                        <span>{timeAgo(mapping.createdAt)}</span>
                      </div>
                    </div>
                    <span className={`mobile-status ${mapping.enabled ? "live" : ""}`}>{mapping.enabled ? "Enabled" : "Disabled"}</span>
                  </div>
                  <div className="mobile-chip-row">
                    <span className="port-tag">Local {mapping.localPort}</span>
                    <span className="port-tag public">Public {mapping.publicPort}</span>
                  </div>
                  {mapping.description && (
                    <div className="mobile-card-meta block">
                      <span>Description</span>
                      <strong>{mapping.description}</strong>
                    </div>
                  )}
                  <div className="mobile-card-actions">
                    <button className="btn-ghost danger" onClick={() => requestDelete(mapping.id, mapping.name)}>
                      <i className="ti ti-trash" /> Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Local Port</th>
                  <th>Public Port</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mappings.map((mapping) => (
                  <tr key={mapping.id}>
                    <td style={{ fontWeight: 600, color: "var(--text-1)" }}>{mapping.name}</td>
                    <td><span className="port-tag">{mapping.localPort}</span></td>
                    <td><span className="port-tag public">{mapping.publicPort}</span></td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{mapping.description ?? "-"}</td>
                    <td>
                      <span className={`action-badge ${mapping.enabled ? "create" : "other"}`}>
                        <i className={`ti ti-${mapping.enabled ? "circle-check" : "circle-x"}`} />
                        {mapping.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td style={{ color: "var(--text-3)", fontSize: 12 }}>{timeAgo(mapping.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <div className="icon-btn danger" title="Delete" onClick={() => requestDelete(mapping.id, mapping.name)}>
                          <i className="ti ti-trash" />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {showCreate && <NewTcpMappingModal onCreate={handleCreate} onClose={() => setShowCreate(false)} />}
    </div>
  );
}
