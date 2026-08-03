import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import type {
  Invoice, InvoiceStatus, InvoiceLine, Client, Project, InvoiceSettings, UpdateInvoicePayload,
} from '../types';
import {
  getInvoices, updateInvoice, updateInvoiceStatus, deleteInvoice,
  getClients, getProjects, getInvoiceSettings,
} from '../api';
import { formatMoney } from '../lib/money';
import AppNav from '../components/AppNav';
import InvoiceLineTable from '../components/InvoiceLineTable';
import InvoiceBuilder, {
  InvoiceMetaFields, metaFromInvoice, clearable, CLEAR, type InvoiceMeta,
} from '../components/InvoiceBuilder';

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUSES: InvoiceStatus[] = ['draft', 'sent', 'paid', 'void'];

const STATUS_PILL: Record<InvoiceStatus, string> = {
  draft: 'text-slate-400 bg-slate-800 border-slate-700',
  sent: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  paid: 'text-green-400 bg-green-400/10 border-green-400/20',
  void: 'text-red-400/70 bg-red-400/5 border-red-400/20',
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'Draft', sent: 'Sent', paid: 'Paid', void: 'Void',
};

// Clearing an optional string field goes through the shared `clearable` helper
// in InvoiceBuilder — including the note on why `currency` is excluded.
//
// On update every clearable field is guarded by `if payload.x is not None`
// (invoices.py:798-820), so a real JSON null reads as "field absent" and leaves
// the stored value untouched — while `discount_value` IS applied via
// model_fields_set. That combination is what let a cleared discount stay live
// in the server's recomputed total.

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-SG', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<InvoiceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');           // list-level load failure
  const [detailError, setDetailError] = useState(''); // save/status/delete failure

  const [filter, setFilter] = useState<'all' | InvoiceStatus>('all');
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);

  // Inline edit state for the selected invoice. The detail pane is a live
  // editor — a sent or paid invoice is never locked (InvoicingPlan §1).
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [meta, setMeta] = useState<InvoiceMeta | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyStatus, setBusyStatus] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [invoicesData, clientsData, projectsData] = await Promise.all([
        getInvoices(), getClients(), getProjects(),
      ]);
      setInvoices(invoicesData);
      setClients(clientsData);
      setProjects(projectsData);
      try {
        setSettings(await getInvoiceSettings());
      } catch {
        setSettings(null);   // defaults are optional — the builder falls back
      }
    } catch {
      setError('Failed to load invoices.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const selectedId = selected?.id;

  // Load an invoice into the editor. Called on selection change and again on a
  // successful save, so the editor always reflects what the server stored —
  // never on plain object identity, which would discard unsaved edits.
  const loadEditor = (invoice: Invoice) => {
    setLines(invoice.lines ?? []);
    setMeta(metaFromInvoice(invoice));
    setDirty(false);
  };

  useEffect(() => {
    if (!selected) { setLines([]); setMeta(null); setDirty(false); return; }
    loadEditor(selected);
    setConfirmDelete(false);
    setDetailError('');
  }, [selectedId]);

  const replaceInvoice = (updated: Invoice) => {
    setInvoices((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    setSelected(updated);
  };

  const handleSave = async () => {
    if (!selected || !meta) return;
    setSaving(true);
    setDetailError('');
    try {
      const payload: UpdateInvoicePayload = {
        // issue_date is not optional server-side and has no sentinel, so an
        // emptied field omits the key and keeps the stored date.
        issue_date: meta.issue_date || undefined,
        // currency is deliberately absent — it is not a clearable field, and
        // the detail editor offers no way to change it.
        due_date: clearable(meta.due_date),
        lines,
        // "null" clears; a real JSON null would be read as "field absent".
        discount_type: (meta.discount_type ?? CLEAR) as UpdateInvoicePayload['discount_type'],
        discount_value: meta.discount_value,
        tax_label: clearable(meta.tax_label),
        tax_percent: meta.tax_percent,
        notes: clearable(meta.notes),
        payment_terms: clearable(meta.payment_terms),
      };
      // The server recomputes every total, so its response is the truth (§5).
      const saved = await updateInvoice(selected.id, payload);
      replaceInvoice(saved);
      loadEditor(saved);
    } catch {
      setDetailError('Failed to save the invoice. Your edits are still here — try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleStatus = async (status: InvoiceStatus) => {
    if (!selected) return;
    setBusyStatus(true);
    setDetailError('');
    try {
      replaceInvoice(await updateInvoiceStatus(selected.id, status));
    } catch {
      setDetailError('Failed to change the invoice status.');
    } finally {
      setBusyStatus(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setDetailError('');
    try {
      await deleteInvoice(selected.id);
      setInvoices((prev) => prev.filter((i) => i.id !== selected.id));
      setSelected(null);
    } catch {
      setDetailError('Failed to delete the invoice.');
      setConfirmDelete(false);
    }
  };

  const filtered = invoices.filter((i) => filter === 'all' || i.status === filter);

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <AppNav active="invoices" wide />

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: invoice list ── */}
        <div className="flex flex-col w-96 border-r border-slate-800 shrink-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <span className="text-sm font-semibold text-white">Invoices</span>
            <div className="flex items-center gap-2">
              <Link
                to="/invoices/settings"
                className="px-2.5 py-1.5 text-xs rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
              >
                Settings
              </Link>
              <button
                onClick={() => setShowBuilder(true)}
                className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
              >
                + New
              </button>
            </div>
          </div>

          <div className="flex gap-1 px-4 py-2.5 border-b border-slate-800/60 flex-wrap">
            {(['all', ...STATUSES] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                  filter === f ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f === 'all' ? 'All' : STATUS_LABEL[f]}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-6 text-sm text-slate-500">Loading…</div>
            ) : error && invoices.length === 0 ? (
              <div className="p-6 text-sm text-red-400">{error}</div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">
                {filter === 'all' ? 'No invoices yet. Create one!' : 'No invoices here.'}
              </div>
            ) : (
              filtered.map((inv) => (
                <div
                  key={inv.id}
                  onClick={() => setSelected(inv)}
                  className={`flex flex-col gap-1 px-4 py-3 border-b border-slate-800/50 cursor-pointer transition-colors ${
                    selected?.id === inv.id
                      ? 'bg-slate-800 border-l-2 border-l-blue-500'
                      : 'hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-100 truncate flex-1">
                      {inv.invoice_number}
                    </span>
                    <span className={`shrink-0 text-xs font-medium px-1.5 py-0.5 rounded-full border ${STATUS_PILL[inv.status]}`}>
                      {STATUS_LABEL[inv.status]}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 truncate flex-1">{inv.client_name}</span>
                    <span className={`text-xs shrink-0 tabular-nums ${
                      inv.total < 0 ? 'text-red-400' : 'text-slate-400'
                    }`}>
                      {formatMoney(inv.total, inv.currency)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Right: detail ── */}
        <div className="flex-1 overflow-hidden">
          {!selected || !meta ? (
            <div className="flex items-center justify-center h-full text-slate-500 text-sm">
              Select an invoice to view details
            </div>
          ) : (
            <div className="flex flex-col h-full overflow-hidden">
              {/* Header */}
              <div className="px-5 py-4 border-b border-slate-700/60 shrink-0">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h2 className="text-base font-semibold text-white">{selected.invoice_number}</h2>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_PILL[selected.status]}`}>
                        {STATUS_LABEL[selected.status]}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      {selected.client_name}
                      {selected.period_start && selected.period_end
                        ? ` · ${formatDate(selected.period_start)} – ${formatDate(selected.period_end)}`
                        : ''}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Issued {formatDate(selected.issue_date)} · Due {formatDate(selected.due_date)}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    {STATUSES.filter((s) => s !== selected.status).map((s) => (
                      <button
                        key={s}
                        onClick={() => handleStatus(s)}
                        disabled={busyStatus}
                        className="px-2.5 py-1 text-xs rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-white transition-colors disabled:opacity-50"
                      >
                        Mark {STATUS_LABEL[s].toLowerCase()}
                      </button>
                    ))}
                    <Link
                      to={`/invoices/${selected.id}/print`}
                      className="px-2.5 py-1 text-xs rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-white transition-colors"
                    >
                      Print
                    </Link>
                    {!confirmDelete ? (
                      <button
                        onClick={() => setConfirmDelete(true)}
                        className="px-2.5 py-1 text-xs rounded-lg bg-slate-800 border border-slate-700 text-red-400 hover:text-red-300 transition-colors"
                      >
                        Delete
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-slate-400">Delete?</span>
                        <button
                          onClick={handleDelete}
                          className="px-2.5 py-1 text-xs rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium transition-colors"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                        >
                          No
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Warn on an issued invoice — but nothing below is disabled */}
                {(selected.status === 'sent' || selected.status === 'paid') && (
                  <p className="mt-3 text-xs text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
                    This invoice is marked {STATUS_LABEL[selected.status].toLowerCase()}. It stays
                    fully editable — the client will not see changes you make here.
                  </p>
                )}

                {detailError && (
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-red-300 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                    <span>{detailError}</span>
                    <button
                      onClick={() => setDetailError('')}
                      className="text-red-400/70 hover:text-red-300 transition-colors shrink-0"
                      title="Dismiss"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
                <InvoiceLineTable
                  lines={lines}
                  currency={selected.currency}
                  discountType={meta.discount_type}
                  discountValue={meta.discount_value}
                  taxLabel={meta.tax_label}
                  taxPercent={meta.tax_percent}
                  onChange={(next) => { setLines(next); setDirty(true); }}
                />

                <div className="border-t border-slate-800 pt-4">
                  <InvoiceMetaFields
                    meta={meta}
                    onChange={(next) => { setMeta(next); setDirty(true); }}
                  />
                </div>

                {selected.bill_to && (
                  <div className="border-t border-slate-800 pt-4">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Bill to</p>
                    <p className="text-sm text-slate-300 whitespace-pre-wrap bg-slate-800/50 rounded-lg p-3">
                      {selected.bill_to}
                    </p>
                  </div>
                )}
              </div>

              {/* Save bar */}
              <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700 shrink-0 bg-slate-900">
                <span className="text-xs text-slate-500">
                  {dirty ? 'Unsaved changes — totals are recomputed by the server on save.' : 'All changes saved.'}
                </span>
                <button
                  onClick={handleSave}
                  disabled={saving || !dirty}
                  className="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {saving && (
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  Save changes
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showBuilder && (
        <InvoiceBuilder
          clients={clients}
          projects={projects}
          settings={settings}
          onCreated={(created) => {
            setInvoices((prev) => [created, ...prev]);
            setSelected(created);
            setShowBuilder(false);
          }}
          onClose={() => setShowBuilder(false)}
        />
      )}
    </div>
  );
}
