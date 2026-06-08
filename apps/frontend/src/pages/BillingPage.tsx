import { useState } from "react";
import type { Toast } from "../app/types";

export function BillingPage({ showToast }: { showToast: (msg: string, type?: Toast["type"]) => void }) {
  const [invoiceOrg, setInvoiceOrg] = useState(() => localStorage.getItem("ptx-billing-org") ?? "");
  const [taxId, setTaxId] = useState(() => localStorage.getItem("ptx-billing-taxid") ?? "");
  const [invoiceEmail, setInvoiceEmail] = useState(() => localStorage.getItem("ptx-billing-email") ?? "");

  const saveDetails = () => {
    localStorage.setItem("ptx-billing-org", invoiceOrg);
    localStorage.setItem("ptx-billing-taxid", taxId);
    localStorage.setItem("ptx-billing-email", invoiceEmail);
    showToast("Invoice details saved to browser storage", "green");
  };

  return (
    <div className="page">
      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-credit-card" /> Current plan</div>
        </div>
        <div className="billing-plan-row">
          <div>
            <div className="plan-name">Self-hosted plan</div>
            <div className="plan-desc">Your own infrastructure - no payment required</div>
          </div>
          <span className="plan-chip">Self-hosted</span>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-file-invoice" /> Invoices</div>
        </div>
        <div className="empty">
          <i className="ti ti-receipt-off" />
          <div className="empty-title">No invoices</div>
          <div className="empty-desc">This self-hosted installation does not require subscription billing.</div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-building" /> Invoice details</div>
        </div>
        <div className="form-body">
          <div className="info-banner" style={{ marginBottom: 16 }}>
            <div className="info-badge"><i className="ti ti-info-circle" /></div>
            <div style={{ flex: 1 }}>
              <div className="info-banner-label">Local preferences</div>
              <div className="info-banner-text">
                Invoice details are saved in your browser storage for reference. No data is sent to a server.
              </div>
            </div>
          </div>
          <div className="form-field">
            <label className="form-lbl">Name on invoice</label>
            <input type="text" className="form-inp" placeholder="Organisation name" value={invoiceOrg} onChange={(event) => setInvoiceOrg(event.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-lbl">Tax ID</label>
            <input type="text" className="form-inp" placeholder="e.g. VAT BE0123456789" value={taxId} onChange={(event) => setTaxId(event.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-lbl">Invoice email</label>
            <input type="email" className="form-inp" placeholder="billing@company.com" value={invoiceEmail} onChange={(event) => setInvoiceEmail(event.target.value)} />
          </div>
          <button className="btn-save" onClick={saveDetails}>
            <i className="ti ti-check" /> Save details
          </button>
        </div>
      </div>
    </div>
  );
}
