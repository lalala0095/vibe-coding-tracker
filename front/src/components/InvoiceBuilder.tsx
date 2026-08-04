import { useState } from 'react';
import type {
  Client, Project, Invoice, InvoiceLine, InvoiceSettings, CreateInvoicePayload,
  InvoiceLineSource,
} from '../types';
import { previewInvoice, createInvoice } from '../api';
import { computeMoney, formatMoney, type DiscountType } from '../lib/money';
import InvoiceLineTable from './InvoiceLineTable';

// ── Helpers ───────────────────────────────────────────────────────────────────

function todaySGT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function startOfMonthSGT(): string {
  return `${todaySGT().slice(0, 7)}-01`;
}

const FIELD =
  'w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm ' +
  'placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';

const LABEL = 'text-xs text-slate-400 mb-1 block';

// ── The "null" clearing sentinel ──────────────────────────────────────────────
// Optional STRING fields are cleared by sending the literal string "null"
// (back/routers/invoices.py::_clear_sentinel, line 201). Both create and update
// honour it, and the create contract is three-way:
//
//   key omitted    -> server applies its settings default
//   value "null"   -> deliberately empty; no default applied
//   any other value-> stored as given
//
// So an empty due date / tax label / payment terms must send "null", not be
// omitted — omitting silently hands back the settings default.
//
// EXCLUDED: `currency` is a string but is non-nullable and has no sentinel
// handling on either path (invoices.py:734, 808). Sending "null" would store
// and print the literal four characters. Never route currency through this.
// Numeric fields (discount_value, tax_percent, rates, hours) keep JSON null.
export const CLEAR = 'null';

export function clearable(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? CLEAR : trimmed;
}

// ── Shared meta fields ────────────────────────────────────────────────────────
// Used by the builder when creating and by InvoicesPage when editing, so the
// two surfaces cannot drift apart.

export interface InvoiceMeta {
  issue_date: string;
  due_date: string;
  discount_type: DiscountType;
  discount_value: number;
  tax_label: string;
  tax_percent: number;
  notes: string;
  payment_terms: string;
  // Print-only. These hide a block on the printed invoice; the value itself is
  // still stored and still editable above.
  show_due_date: boolean;
  show_payment_terms: boolean;
}

export function defaultMeta(settings: InvoiceSettings | null): InvoiceMeta {
  const issue = todaySGT();
  return {
    issue_date: issue,
    due_date: addDays(issue, settings?.default_due_days ?? 14),
    discount_type: null,
    discount_value: 0,
    tax_label: settings?.default_tax_label ?? '',
    tax_percent: settings?.default_tax_percent ?? 0,
    notes: '',
    payment_terms: settings?.default_payment_terms ?? '',
    show_due_date: true,
    show_payment_terms: true,
  };
}

export function metaFromInvoice(invoice: Invoice): InvoiceMeta {
  return {
    issue_date: invoice.issue_date ?? '',
    due_date: invoice.due_date ?? '',
    discount_type: invoice.discount_type,
    discount_value: invoice.discount_value ?? 0,
    tax_label: invoice.tax_label ?? '',
    tax_percent: invoice.tax_percent ?? 0,
    notes: invoice.notes ?? '',
    payment_terms: invoice.payment_terms ?? '',
    // `!== false`, so an invoice stored before these fields existed reads as
    // showing both — which is what it already prints.
    show_due_date: invoice.show_due_date !== false,
    show_payment_terms: invoice.show_payment_terms !== false,
  };
}

export function InvoiceMetaFields({
  meta, onChange,
}: {
  meta: InvoiceMeta;
  onChange: (meta: InvoiceMeta) => void;
}) {
  const set = (changes: Partial<InvoiceMeta>) => onChange({ ...meta, ...changes });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className={LABEL}>Issue date</label>
          <input
            type="date"
            value={meta.issue_date}
            onChange={(e) => set({ issue_date: e.target.value })}
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL}>Due date</label>
          <input
            type="date"
            value={meta.due_date}
            onChange={(e) => set({ due_date: e.target.value })}
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL}>Discount</label>
          <select
            value={meta.discount_type ?? ''}
            onChange={(e) =>
              set({ discount_type: (e.target.value || null) as DiscountType })
            }
            className={FIELD}
          >
            <option value="">None</option>
            <option value="percent">Percent</option>
            <option value="amount">Amount</option>
          </select>
        </div>
        <div>
          <label className={LABEL}>
            Discount value{meta.discount_type === 'percent' ? ' (%)' : ''}
          </label>
          <input
            type="number"
            step="0.01"
            value={meta.discount_value}
            onChange={(e) => set({ discount_value: Number(e.target.value) || 0 })}
            className={FIELD}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className={LABEL}>Tax label</label>
          <input
            type="text"
            value={meta.tax_label}
            onChange={(e) => set({ tax_label: e.target.value })}
            placeholder="GST"
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL}>Tax percent</label>
          <input
            type="number"
            step="0.01"
            value={meta.tax_percent}
            onChange={(e) => set({ tax_percent: Number(e.target.value) || 0 })}
            className={FIELD}
          />
        </div>
        <div className="col-span-2">
          <label className={LABEL}>Payment terms</label>
          <input
            type="text"
            value={meta.payment_terms}
            onChange={(e) => set({ payment_terms: e.target.value })}
            placeholder="Net 14"
            className={FIELD}
          />
        </div>
      </div>

      <div>
        <label className={LABEL}>Notes</label>
        <textarea
          rows={2}
          value={meta.notes}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="Anything to show on the invoice…"
          className={`${FIELD} resize-none`}
        />
      </div>

      {/* Print visibility. These hide a block on the printed document only —
          the due date and payment terms above stay stored and stay editable. */}
      <div>
        <label className={LABEL}>Show on the printed invoice</label>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={meta.show_due_date}
              onChange={(e) => set({ show_due_date: e.target.checked })}
              className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-0"
            />
            <span className="text-sm text-slate-300">Due date</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={meta.show_payment_terms}
              onChange={(e) => set({ show_payment_terms: e.target.checked })}
              className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-0"
            />
            <span className="text-sm text-slate-300">Payment terms</span>
          </label>
        </div>
      </div>
    </div>
  );
}

// ── Builder ───────────────────────────────────────────────────────────────────

// Build-time facts about a previewed line that the stored shape cannot hold.
// Builder line state is InvoiceLine[], which carries neither `source` nor
// `duplicate_reason`, so they are kept beside it keyed by line_id — the same
// workaround the claimed-invoice list already uses.
interface PreviewMeta {
  source: InvoiceLineSource;
  duplicate_reason: string | null;
}

interface Props {
  clients: Client[];
  projects: Project[];
  settings: InvoiceSettings | null;
  onCreated: (invoice: Invoice) => void;
  onClose: () => void;
}

export default function InvoiceBuilder({ clients, projects, settings, onCreated, onClose }: Props) {
  const [clientId, setClientId] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [periodStart, setPeriodStart] = useState(startOfMonthSGT());
  const [periodEnd, setPeriodEnd] = useState(todaySGT());
  const [includeInvoiced, setIncludeInvoiced] = useState(false);
  const [includeTrackers, setIncludeTrackers] = useState(true);

  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [currency, setCurrency] = useState(settings?.default_currency ?? 'USD');
  const [runningCount, setRunningCount] = useState(0);
  const [claimedCount, setClaimedCount] = useState(0);
  const [claimedInvoices, setClaimedInvoices] = useState<string[]>([]);
  const [trackerLineCount, setTrackerLineCount] = useState(0);
  const [duplicateTrackerCount, setDuplicateTrackerCount] = useState(0);
  const [previewMeta, setPreviewMeta] = useState<Map<string, PreviewMeta>>(new Map());
  // Lines the user has ticked off. Only lines the preview marked
  // `include_by_default: false` start in here — everything else is included,
  // which is what task lines have always done.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [previewed, setPreviewed] = useState(false);
  const [staleSource, setStaleSource] = useState(false);

  const [meta, setMeta] = useState<InvoiceMeta>(() => defaultMeta(settings));

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const clientProjects = projects.filter((p) => p.client_id === clientId);
  const selectedClient = clients.find((c) => c.id === clientId);

  // What the POST will actually carry. An excluded line stays on screen and
  // stays editable — it just is not billed.
  const includedLines = lines.filter((l) => !excluded.has(l.line_id));

  // Derived through lib/money, not by re-adding the `amount` values the preview
  // returned — those go stale the moment a line's hours or rate is edited.
  const footerMoney = computeMoney(
    includedLines, meta.discount_type, meta.discount_value, meta.tax_percent
  );

  // Any change to what the preview is built FROM invalidates the lines it
  // produced. Without this, switching client after a preview left the previous
  // client's lines on screen with Create still enabled — creating would then
  // stamp this client's invoice number onto the other client's time entries.
  const invalidatePreview = () => {
    setStaleSource(lines.length > 0);
    setLines([]);
    setPreviewed(false);
    setRunningCount(0);
    setClaimedCount(0);
    setClaimedInvoices([]);
    setTrackerLineCount(0);
    setDuplicateTrackerCount(0);
    setPreviewMeta(new Map());
    setExcluded(new Set());
  };

  const toggleProject = (id: string) => {
    setProjectIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
    invalidatePreview();
  };

  const handlePreview = async () => {
    if (!clientId) { setError('Pick a client first.'); return; }
    if (!periodStart || !periodEnd) { setError('Pick a period.'); return; }
    setLoadingPreview(true);
    setError('');
    try {
      const preview = await previewInvoice({
        client_id: clientId,
        project_ids: projectIds.length > 0 ? projectIds : undefined,
        period_start: periodStart,
        period_end: periodEnd,
        include_invoiced: includeInvoiced,
        include_trackers: includeTrackers,
      });

      const previewLines = preview.lines ?? [];

      setLines(previewLines);
      setCurrency(preview.currency || selectedClient?.currency || 'USD');
      setRunningCount(preview.running_entry_count ?? 0);
      setClaimedCount(preview.claimed_entry_count ?? 0);
      setTrackerLineCount(preview.tracker_line_count ?? 0);
      setDuplicateTrackerCount(preview.duplicate_tracker_count ?? 0);
      // Distinct invoice numbers across every claimed line, first-seen order.
      setClaimedInvoices([
        ...new Set(previewLines.flatMap((l) => l.claimed_by ?? [])),
      ]);
      // Kept beside the lines because InvoiceLine cannot carry them.
      setPreviewMeta(new Map(previewLines.map((l) => [
        l.line_id, { source: l.source, duplicate_reason: l.duplicate_reason ?? null },
      ])));
      // Only an explicit `false` excludes. A line from an older server that
      // omits the field, and every manually added line, stays included.
      setExcluded(new Set(
        previewLines.filter((l) => l.include_by_default === false).map((l) => l.line_id)
      ));
      setPreviewed(true);
      setStaleSource(false);
    } catch {
      setError('Failed to load time entries for that period.');
    } finally {
      setLoadingPreview(false);
    }
  };

  const toggleExclude = (lineId: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId); else next.add(lineId);
      return next;
    });
  };

  const handleSave = async () => {
    if (!clientId) { setError('Pick a client first.'); return; }
    setSaving(true);
    setError('');
    try {
      const payload: CreateInvoicePayload = {
        client_id: clientId,
        project_ids: projectIds,
        issue_date: meta.issue_date,
        period_start: periodStart,
        period_end: periodEnd,
        // currency is deliberately NOT clearable — see the note on CLEAR.
        // Omitted when blank so the server resolves it from the client.
        ...(currency.trim() ? { currency: currency.trim() } : {}),
        // Only the ticked lines are billed. Un-ticking is the whole point of
        // the checkbox column, so the excluded ones are dropped here rather
        // than sent and filtered server-side.
        lines: includedLines,
        // An emptied field means "none", so it sends the sentinel rather than
        // being omitted, which would take the settings default instead.
        due_date: clearable(meta.due_date),
        tax_label: clearable(meta.tax_label),
        notes: clearable(meta.notes),
        payment_terms: clearable(meta.payment_terms),
        // discount_type needs no sentinel on create: null already maps to None
        // and no default is applied to it (invoices.py:707-711). Update differs
        // — its guard is `is not None`, so there it must send "null".
        discount_type: meta.discount_type,
        discount_value: meta.discount_value,
        tax_percent: meta.tax_percent,
        show_due_date: meta.show_due_date,
        show_payment_terms: meta.show_payment_terms,
      };
      onCreated(await createInvoice(payload));
    } catch {
      setError('Failed to save the invoice.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden"
           style={{ maxHeight: '90vh' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <h2 className="text-base font-semibold text-white">New Invoice</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
          {/* ── Source: client, projects, period ── */}
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={LABEL}>Client</label>
                <select
                  value={clientId}
                  onChange={(e) => {
                    setClientId(e.target.value);
                    setProjectIds([]);
                    invalidatePreview();
                  }}
                  className={FIELD}
                >
                  <option value="">Select a client…</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL}>Period start</label>
                <input
                  type="date"
                  value={periodStart}
                  onChange={(e) => { setPeriodStart(e.target.value); invalidatePreview(); }}
                  className={FIELD}
                />
              </div>
              <div>
                <label className={LABEL}>Period end</label>
                <input
                  type="date"
                  value={periodEnd}
                  onChange={(e) => { setPeriodEnd(e.target.value); invalidatePreview(); }}
                  className={FIELD}
                />
              </div>
            </div>

            {clientId && clientProjects.length > 0 && (
              <div>
                <label className={LABEL}>
                  Projects <span className="text-slate-600">(all projects if none selected)</span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {clientProjects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => toggleProject(p.id)}
                      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                        projectIds.includes(p.id)
                          ? 'bg-violet-500/15 border-violet-500/40 text-violet-300'
                          : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-4 flex-wrap">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeInvoiced}
                    onChange={(e) => { setIncludeInvoiced(e.target.checked); invalidatePreview(); }}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-0"
                  />
                  <span className="text-xs text-slate-400">Include already-invoiced entries</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeTrackers}
                    onChange={(e) => { setIncludeTrackers(e.target.checked); invalidatePreview(); }}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-0"
                  />
                  <span className="text-xs text-slate-400">Include trackers</span>
                </label>
              </div>
              <button
                onClick={handlePreview}
                disabled={loadingPreview}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {loadingPreview && (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                )}
                {previewed ? 'Reload time entries' : 'Load time entries'}
              </button>
            </div>
          </div>

          {staleSource && (
            <p className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
              The client, projects or period changed, so the previous lines no longer apply.
              Load the time entries again to rebuild them.
            </p>
          )}

          {/* Running entries were excluded from the preview (§10) */}
          {runningCount > 0 && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
              <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <p className="text-xs text-amber-300 leading-relaxed">
                {runningCount} time {runningCount === 1 ? 'entry is' : 'entries are'} still running
                and {runningCount === 1 ? 'was' : 'were'} excluded. Set an end time or manual hours
                on {runningCount === 1 ? 'it' : 'them'} to bill {runningCount === 1 ? 'it' : 'them'}.
              </p>
            </div>
          )}

          {/* Already billed elsewhere (§12). This is the only build-time signal
              the user gets — the entry badge names one claimant, not all. */}
          {claimedCount > 0 && (
            <div className="flex items-start gap-2.5 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2.5">
              <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <p className="text-xs text-red-300 leading-relaxed">
                {claimedCount} time {claimedCount === 1 ? 'entry is' : 'entries are'} already billed
                on {claimedInvoices.length > 0 ? claimedInvoices.join(', ') : 'another invoice'}.
                Invoicing {claimedCount === 1 ? 'it' : 'them'} again will charge the same hours twice.
              </p>
            </div>
          )}

          {/* Tracker lines whose hours are already on the invoice as task
              lines. They arrive unticked, but stay tickable — warn, never
              block (§ no locking). */}
          {duplicateTrackerCount > 0 && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
              <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <p className="text-xs text-amber-300 leading-relaxed">
                {duplicateTrackerCount} tracker {duplicateTrackerCount === 1 ? 'line' : 'lines'} arrived
                unticked because {duplicateTrackerCount === 1 ? 'its' : 'their'} time entries are
                already listed as {duplicateTrackerCount === 1 ? 'a line of its own' : 'lines of their own'}.
                Ticking {duplicateTrackerCount === 1 ? 'it' : 'one'} would bill the same hours twice.
              </p>
            </div>
          )}

          {previewed && (
            <>
              <div className="border-t border-slate-800 pt-4">
                <InvoiceLineTable
                  lines={lines}
                  currency={currency}
                  discountType={meta.discount_type}
                  discountValue={meta.discount_value}
                  taxLabel={meta.tax_label}
                  taxPercent={meta.tax_percent}
                  onChange={setLines}
                  excludedIds={excluded}
                  onToggleExclude={toggleExclude}
                  // A manually added line has no preview entry, so it has no
                  // caveat — and is never auto-excluded.
                  reasonForLine={(id) => previewMeta.get(id)?.duplicate_reason ?? null}
                />
              </div>

              <div className="border-t border-slate-800 pt-4">
                <InvoiceMetaFields meta={meta} onChange={setMeta} />
              </div>
            </>
          )}

          {error && (
            <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700 shrink-0 bg-slate-900">
          {/* Counts what will be billed, not what is on screen — an unticked
              line is still listed and still editable. */}
          <span className="text-xs text-slate-500">
            {lines.length > 0
              ? `${includedLines.length} of ${lines.length} line${lines.length !== 1 ? 's' : ''}` +
                (trackerLineCount > 0
                  ? ` (${trackerLineCount} from ${trackerLineCount === 1 ? 'a tracker' : 'trackers'})`
                  : '') +
                ` · ${formatMoney(footerMoney.subtotal, currency)} before discount and tax`
              : 'Server assigns the invoice number on save.'}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg text-slate-300 hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !clientId || !previewed}
              className="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {saving && (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              )}
              Create Invoice
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
