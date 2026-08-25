import { useMemo, useState } from 'react';
import type { HoursRoundingDirection, Invoice, InvoiceLine, InvoicePreviewLine, Project } from '../types';
import { previewInvoice } from '../api';
import { mergeRegeneratedLines, type LineChange, type LineChangeKind, type MergeResult } from '../lib/regenerate';
// `todaySgt()` and not `new Date().toISOString()`: the latter is UTC, so
// between midnight and 08:00 in Singapore it names yesterday — and the whole
// point of this option is to stamp the day the invoice was actually re-issued.
import { todaySgt } from '../lib/week';
import Modal, { MODAL_CANCEL_BUTTON, MODAL_PRIMARY_BUTTON, ButtonSpinner } from './Modal';
// The form classes live with the other shared invoice-UI pieces rather than
// being restated here, which is what let the three dialogs drift.
import { FIELD, LABEL, CHECKBOX } from './InvoiceBuilder';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  updated:
    'Hours, dates, or a tracker’s sub-tasks moved. Your rate and description are kept.',
  removed: 'No longer backed by any time entry in this period. Applying drops these lines.',
  unchanged: 'Nothing to do.',
  manual: 'Added by hand, so nothing regenerates them.',
};

function hoursText(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}h`;
}

// Spell the configured rule out on the checkbox itself, so the user knows what
// ticking it does without leaving to read Settings.
function roundingLabel(increment: number, direction: HoursRoundingDirection): string {
  const verb =
    direction === 'up' ? 'Round up to' : direction === 'down' ? 'Round down to' : 'Round to the nearest';
  return `${verb} ${increment} h`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

interface Props {
  invoice: Invoice;
  projects: Project[];
  // The editor's working lines, which may hold unsaved edits — those take part
  // in the merge, so a hand-typed rate is preserved even before it is saved.
  currentLines: InvoiceLine[];
  // The saved billing increment. Absent (or not positive) means no rounding is
  // configured, and the option is not offered at all.
  roundingIncrement?: number;
  roundingDirection?: HoursRoundingDirection;
  onApply: (
    lines: InvoiceLine[],
    periodStart: string,
    periodEnd: string,
    /** A bare `YYYY-MM-DD` to set as the issue date, or null to leave it alone. */
    issueDate: string | null,
  ) => void;
  onClose: () => void;
}

export default function RegenerateModal({
  invoice, projects, currentLines, roundingIncrement, roundingDirection, onApply, onClose,
}: Props) {
  const [periodStart, setPeriodStart] = useState(invoice.period_start ?? '');
  const [periodEnd, setPeriodEnd] = useState(invoice.period_end ?? '');
  const [projectIds, setProjectIds] = useState<string[]>(invoice.project_ids ?? []);
  const [includeTrackers, setIncludeTrackers] = useState(true);
  const [includeInvoiced, setIncludeInvoiced] = useState(false);

  // Pinned once for the life of the dialog, so the date shown on the checkbox
  // is exactly the date Apply hands back even if the modal is left open across
  // Singapore midnight.
  const today = useMemo(() => todaySgt(), []);
  // On by default: a regenerated invoice is being re-issued, and the printed
  // document should carry the day it was re-issued rather than the day it was
  // first raised. It stays a default — the field itself remains editable.
  const [updateIssueDate, setUpdateIssueDate] = useState(true);

  const canRound =
    typeof roundingIncrement === 'number' && Number.isFinite(roundingIncrement) && roundingIncrement > 0;
  // On by default when an increment is configured: the owner set it precisely so
  // that billed hours land on it, and a regenerate that ignored it would hand
  // back raw figures they would then have to round again by hand.
  const [roundHours, setRoundHours] = useState(canRound);
  const direction: HoursRoundingDirection = roundingDirection ?? 'nearest';

  // The preview is kept raw rather than pre-merged, so flipping the rounding
  // checkbox re-merges in place instead of sending the user back to Load.
  const [preview, setPreview] = useState<InvoicePreviewLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const result: MergeResult | null = useMemo(() => {
    if (preview === null) return null;
    const rounding =
      roundHours && typeof roundingIncrement === 'number' && roundingIncrement > 0
        ? { increment: roundingIncrement, direction }
        : null;
    return mergeRegeneratedLines(currentLines, preview, rounding);
  }, [preview, currentLines, roundHours, roundingIncrement, direction]);

  // The client is a snapshot on the invoice and the server will not accept a
  // different one, so it is shown rather than offered.
  const clientProjects = projects.filter((p) => p.client_id === invoice.client_id);

  const periodChanged =
    periodStart !== (invoice.period_start ?? '') || periodEnd !== (invoice.period_end ?? '');

  const toggleProject = (id: string) => {
    setProjectIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
    setPreview(null);   // the summary was built from the old source; drop it
  };

  const handleLoad = async () => {
    if (!periodStart || !periodEnd) { setError('Pick a period.'); return; }
    setLoading(true);
    setError('');
    try {
      const fresh = await previewInvoice({
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
      setPreview(fresh.lines ?? []);
    } catch {
      setError('Failed to load time entries for that period.');
    } finally {
      setLoading(false);
    }
  };

  const issued = invoice.status !== 'draft';

  // Rendered in both steps: the summary re-merges the moment it is flipped, so
  // the user can see the rounded and unrounded outcome without reloading.
  // Hidden entirely when no increment is configured — nothing to round to.
  const roundingToggle =
    canRound && roundingIncrement !== undefined ? (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={roundHours}
          onChange={(e) => setRoundHours(e.target.checked)}
          className={CHECKBOX}
        />
        <span className="text-xs text-slate-400">
          Round hours to the billing increment
          <span className="text-slate-500"> · {roundingLabel(roundingIncrement, direction)}</span>
        </span>
      </label>
    ) : null;

  // Also rendered in both steps. The date is spelled out the way the rounding
  // rule is: the user should not have to work out which day they are agreeing
  // to stamp on the document.
  // `hasChanges` speaks only for the LINES. With the issue-date option on,
  // Apply still does something to an invoice whose lines already match — it
  // re-dates the document — so gating the button on `hasChanges` alone would
  // make the option unreachable in exactly the case someone regenerates a
  // settled invoice just to re-issue it today.
  const issueDateWouldMove = updateIssueDate && today !== (invoice.issue_date ?? '');
  const canApply = result !== null && (result.hasChanges || issueDateWouldMove);

  const issueDateToggle = (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={updateIssueDate}
        onChange={(e) => setUpdateIssueDate(e.target.checked)}
        className={CHECKBOX}
      />
      <span className="text-xs text-slate-400">
        Update the issue date to today
        <span className="text-slate-500"> · {today}</span>
      </span>
    </label>
  );

  return (
    <Modal
      title={`Regenerate lines · ${invoice.invoice_number}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <span className="text-xs text-slate-500">
            {result === null
              ? 'Nothing is written to the server here.'
              : `${currentLines.length} line${currentLines.length !== 1 ? 's' : ''} now · ${result.lines.length} after applying`}
          </span>
          <div className="flex gap-2">
            {result !== null && (
              <button onClick={() => setPreview(null)} className={MODAL_CANCEL_BUTTON}>
                Back
              </button>
            )}
            <button onClick={onClose} className={MODAL_CANCEL_BUTTON}>
              {result !== null && !canApply ? 'Close' : 'Cancel'}
            </button>
            {result === null ? (
              <button
                onClick={handleLoad}
                disabled={loading}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {loading && <ButtonSpinner />}
                Load changes
              </button>
            ) : (
              /* Offered whenever applying would change something — the lines,
                 or the issue date on its own. A true no-op is not offered. */
              canApply && (
                <button
                  onClick={() => {
                    onApply(
                      result.lines, periodStart, periodEnd,
                      updateIssueDate ? today : null,
                    );
                    onClose();
                  }}
                  className={MODAL_PRIMARY_BUTTON}
                >
                  Apply to invoice
                </button>
              )
            )}
          </div>
        </>
      }
    >
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
            {roundingToggle}
            {issueDateToggle}
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            Your rates, descriptions and task lists are kept. Only hours, dates and which lines
            exist are refreshed. Nothing is saved until you press Save changes on the invoice.
          </p>
        </div>
      ) : (
        /* ── Step 2: what applying would do ── */
        <div className="flex flex-col gap-4">
          {/* Unconditional now: the issue-date toggle is always offered, so
              this box no longer hangs on a rounding increment existing. */}
          <div className="flex items-center gap-4 flex-wrap rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2">
            {roundingToggle}
            {issueDateToggle}
          </div>
          <ChangeSummary result={result} issueDate={issueDateWouldMove ? today : null} />
        </div>
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
    </Modal>
  );
}

// ── Change summary ────────────────────────────────────────────────────────────

function ChangeSummary({ result, issueDate }: { result: MergeResult; issueDate: string | null }) {
  const delta = result.hoursAfter - result.hoursBefore;

  if (!result.hasChanges) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-slate-300">
          This invoice is already up to date — the current time entries produce exactly the lines
          it already has.
        </p>
        {/* Without this the panel reads as "nothing to do" while an Apply
            button sits below it offering to change the date. */}
        {issueDate && (
          <p className="text-sm text-slate-300">
            Applying would still re-date it to {issueDate}.
          </p>
        )}
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
        {/* Only tracker lines can reach this — the merge leaves a task line's
            bullets alone. Spelled out rather than counted: the whole point of
            the change is *which* sub-tasks the client will see listed. */}
        {change.subItemsChanged && (
          <p className="text-xs opacity-80 mt-0.5">
            {change.line.sub_items.length > 0
              ? `Sub-tasks change to: ${change.line.sub_items.join(', ')}`
              : 'Sub-tasks cleared — the tracker no longer lists any.'}
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
