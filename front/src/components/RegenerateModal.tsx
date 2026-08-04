import { useState } from 'react';
import type { Invoice, InvoiceLine, Project } from '../types';
import { previewInvoice } from '../api';
import { mergeRegeneratedLines, type LineChange, type LineChangeKind, type MergeResult } from '../lib/regenerate';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIELD =
  'w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm ' +
  'placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';

const LABEL = 'text-xs text-slate-400 mb-1 block';

const CHECKBOX =
  'w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-0';

// Grouped in the order the user reads them: what is new, what moved, what
// disappeared, then the untouched remainder.
const KIND_ORDER: LineChangeKind[] = ['added', 'updated', 'removed', 'unchanged', 'manual'];

const KIND_LABEL: Record<LineChangeKind, string> = {
  added: 'Added',
  updated: 'Updated',
  removed: 'Removed',
  unchanged: 'Unchanged',
  manual: 'Manual lines (kept as-is)',
};

// Colour carries the meaning here, so it follows the same palette the rest of
// the invoice UI uses for good / caution / destructive.
const KIND_STYLE: Record<LineChangeKind, string> = {
  added: 'border-green-400/30 bg-green-400/5 text-green-300',
  updated: 'border-amber-400/30 bg-amber-400/5 text-amber-300',
  removed: 'border-red-400/30 bg-red-400/10 text-red-300',
  unchanged: 'border-slate-700 bg-slate-800/40 text-slate-400',
  manual: 'border-slate-700 bg-slate-800/40 text-slate-400',
};

const KIND_BLURB: Record<LineChangeKind, string> = {
  added: 'New work found in this period.',
  updated: 'Hours or dates moved. Your rate, description and task list are kept.',
  removed: 'No longer backed by any time entry in this period. Applying drops these lines.',
  unchanged: 'Nothing to do.',
  manual: 'Added by hand, so nothing regenerates them.',
};

function hoursText(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}h`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

interface Props {
  invoice: Invoice;
  projects: Project[];
  // The editor's working lines, which may hold unsaved edits — those take part
  // in the merge, so a hand-typed rate is preserved even before it is saved.
  currentLines: InvoiceLine[];
  onApply: (lines: InvoiceLine[], periodStart: string, periodEnd: string) => void;
  onClose: () => void;
}

export default function RegenerateModal({ invoice, projects, currentLines, onApply, onClose }: Props) {
  const [periodStart, setPeriodStart] = useState(invoice.period_start ?? '');
  const [periodEnd, setPeriodEnd] = useState(invoice.period_end ?? '');
  const [projectIds, setProjectIds] = useState<string[]>(invoice.project_ids ?? []);
  const [includeTrackers, setIncludeTrackers] = useState(true);
  const [includeInvoiced, setIncludeInvoiced] = useState(false);

  const [result, setResult] = useState<MergeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // The client is a snapshot on the invoice and the server will not accept a
  // different one, so it is shown rather than offered.
  const clientProjects = projects.filter((p) => p.client_id === invoice.client_id);

  const periodChanged =
    periodStart !== (invoice.period_start ?? '') || periodEnd !== (invoice.period_end ?? '');

  const toggleProject = (id: string) => {
    setProjectIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
    setResult(null);   // the summary was built from the old source; drop it
  };

  const handleLoad = async () => {
    if (!periodStart || !periodEnd) { setError('Pick a period.'); return; }
    setLoading(true);
    setError('');
    try {
      const preview = await previewInvoice({
        client_id: invoice.client_id,
        project_ids: projectIds.length > 0 ? projectIds : undefined,
        period_start: periodStart,
        period_end: periodEnd,
        include_invoiced: includeInvoiced,
        include_trackers: includeTrackers,
        // Without this the invoice's own claims read as "already billed" and
        // the preview would come back all but empty.
        for_invoice_id: invoice.id,
      });
      setResult(mergeRegeneratedLines(currentLines, preview.lines ?? []));
    } catch {
      setError('Failed to load time entries for that period.');
    } finally {
      setLoading(false);
    }
  };

  const issued = invoice.status !== 'draft';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl flex flex-col overflow-hidden"
           style={{ maxHeight: '90vh' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <h2 className="text-base font-semibold text-white">
            Regenerate lines · {invoice.invoice_number}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
          {/* Warn on an issued invoice — nothing below is disabled (§1) */}
          {issued && (
            <p className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2 leading-relaxed">
              This invoice is already marked {invoice.status}. Regenerating changes what it bills,
              and the client may already have the old figures. You can still do it.
            </p>
          )}

          {result === null ? (
            /* ── Step 1: what to pull from ── */
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className={LABEL}>Client</label>
                  <p className="px-3 py-2 text-sm text-slate-300 bg-slate-800/50 border border-slate-800 rounded-lg truncate">
                    {invoice.client_name}
                  </p>
                </div>
                <div>
                  <label className={LABEL}>Period start</label>
                  <input
                    type="date"
                    value={periodStart}
                    onChange={(e) => setPeriodStart(e.target.value)}
                    className={FIELD}
                  />
                </div>
                <div>
                  <label className={LABEL}>Period end</label>
                  <input
                    type="date"
                    value={periodEnd}
                    onChange={(e) => setPeriodEnd(e.target.value)}
                    className={FIELD}
                  />
                </div>
              </div>

              {clientProjects.length > 0 && (
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

              <div className="flex items-center gap-4 flex-wrap">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeTrackers}
                    onChange={(e) => setIncludeTrackers(e.target.checked)}
                    className={CHECKBOX}
                  />
                  <span className="text-xs text-slate-400">Include trackers</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeInvoiced}
                    onChange={(e) => setIncludeInvoiced(e.target.checked)}
                    className={CHECKBOX}
                  />
                  <span className="text-xs text-slate-400">
                    Include entries already billed on another invoice
                  </span>
                </label>
              </div>

              <p className="text-xs text-slate-500 leading-relaxed">
                Your rates, descriptions and task lists are kept. Only hours, dates and which lines
                exist are refreshed. Nothing is saved until you press Save changes on the invoice.
              </p>
            </div>
          ) : (
            /* ── Step 2: what applying would do ── */
            <ChangeSummary result={result} />
          )}

          {result !== null && periodChanged && (
            <p className="text-xs text-slate-400 bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2 leading-relaxed">
              The period differs from the one stored on this invoice. Applying also updates it to{' '}
              {periodStart} – {periodEnd}, because that is what prints on the document.
            </p>
          )}

          {error && (
            <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700 shrink-0 bg-slate-900">
          <span className="text-xs text-slate-500">
            {result === null
              ? 'Nothing is written to the server here.'
              : `${currentLines.length} line${currentLines.length !== 1 ? 's' : ''} now · ${result.lines.length} after applying`}
          </span>
          <div className="flex gap-2">
            {result !== null && (
              <button
                onClick={() => setResult(null)}
                className="px-4 py-2 text-sm rounded-lg text-slate-300 hover:bg-slate-800 transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg text-slate-300 hover:bg-slate-800 transition-colors"
            >
              {result !== null && !result.hasChanges ? 'Close' : 'Cancel'}
            </button>
            {result === null ? (
              <button
                onClick={handleLoad}
                disabled={loading}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {loading && (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                )}
                Load changes
              </button>
            ) : (
              /* Already up to date: Apply would be a no-op, so it is not offered */
              result.hasChanges && (
                <button
                  onClick={() => { onApply(result.lines, periodStart, periodEnd); onClose(); }}
                  className="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors"
                >
                  Apply to invoice
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Change summary ────────────────────────────────────────────────────────────

function ChangeSummary({ result }: { result: MergeResult }) {
  const delta = result.hoursAfter - result.hoursBefore;

  if (!result.hasChanges) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-slate-300">
          This invoice is already up to date — the current time entries produce exactly the lines
          it already has.
        </p>
        <p className="text-xs text-slate-500">
          {hoursText(result.hoursBefore)} across {result.lines.length} line
          {result.lines.length !== 1 ? 's' : ''}.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The headline number, before anything is read line by line */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm text-slate-400">Total hours</span>
        <span className="text-base text-slate-300 tabular-nums">{hoursText(result.hoursBefore)}</span>
        <span className="text-slate-500">→</span>
        <span className={`text-base font-semibold tabular-nums ${
          delta > 0 ? 'text-green-300' : delta < 0 ? 'text-red-300' : 'text-slate-200'
        }`}>
          {hoursText(result.hoursAfter)}
        </span>
        {delta !== 0 && (
          <span className={`text-xs tabular-nums ${delta > 0 ? 'text-green-400/80' : 'text-red-400/80'}`}>
            ({delta > 0 ? '+' : '−'}{Math.abs(delta).toFixed(2)}h)
          </span>
        )}
      </div>

      <p className="text-xs text-slate-500 leading-relaxed">
        Your rates, descriptions and task lists are kept. Only hours, dates and which lines exist
        are refreshed. Nothing is saved until you press Save changes on the invoice.
      </p>

      {/* Dropping lines is the one irreversible-feeling outcome here, so it is
          called out above the list as well as coloured inside it. */}
      {result.counts.removed > 0 && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2.5">
          <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <p className="text-xs text-red-300 leading-relaxed">
            {result.counts.removed} {result.counts.removed === 1 ? 'line will be removed' : 'lines will be removed'} from
            this invoice. Their hours stop being billed here. Check the red group below before applying.
          </p>
        </div>
      )}

      {KIND_ORDER.map((kind) => {
        const group = result.changes.filter((c) => c.kind === kind);
        if (group.length === 0) return null;
        return (
          <div key={kind} className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {KIND_LABEL[kind]}
              </span>
              <span className="text-xs text-slate-600">{group.length}</span>
            </div>
            <p className="text-xs text-slate-600 leading-snug">{KIND_BLURB[kind]}</p>
            <div className="flex flex-col gap-1">
              {group.map((change) => (
                <ChangeRow key={change.line.line_id} change={change} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChangeRow({ change }: { change: LineChange }) {
  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 ${KIND_STYLE[change.kind]}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm truncate">{change.title || 'Untitled line'}</span>
          {change.isTracker && (
            <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-violet-500/40 bg-violet-500/10 text-violet-300">
              tracker
            </span>
          )}
        </div>
        {change.datesChanged && (
          <p className="text-xs opacity-80 mt-0.5">
            Dates change to {change.line.date_from ?? '—'} – {change.line.date_to ?? '—'}
          </p>
        )}
      </div>

      <span className="shrink-0 text-xs tabular-nums self-center">
        {change.kind === 'updated'
          ? `${hoursText(change.hoursBefore)} → ${hoursText(change.hoursAfter)}`
          : change.kind === 'removed'
            ? hoursText(change.hoursBefore)
            : hoursText(change.hoursAfter ?? change.hoursBefore)}
      </span>
    </div>
  );
}
