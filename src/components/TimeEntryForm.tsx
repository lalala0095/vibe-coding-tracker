import { useState, useEffect, useRef } from 'react';
import type { TimeEntry } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────
// Duplicated from TrackersPage.tsx, matching how this codebase already repeats
// the datetime-local helpers per module.

function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  // datetime-local input expects "YYYY-MM-DDTHH:mm"
  return iso.slice(0, 16);
}

function nowLocalInputValue(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// Convert a datetime-local string to a full ISO-8601 string with offset.
// Since we work in SGT (UTC+8) we append +08:00 if no offset is present.
function toISOWithOffset(local: string): string {
  if (!local) return '';
  if (local.includes('+') || local.toLowerCase().includes('z')) return local;
  return `${local}:00+08:00`;
}

// The timer-derived hours, rounded to 2 dp (InvoicingPlan §2.1).
// null when there is nothing to derive — a running entry has no duration yet.
function timerHours(startLocal: string, endLocal: string): number | null {
  if (!startLocal || !endLocal) return null;
  const ms = new Date(toISOWithOffset(endLocal)).getTime() - new Date(toISOWithOffset(startLocal)).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round((ms / 3600000) * 100) / 100;
}

// ── Form values ───────────────────────────────────────────────────────────────
// The form speaks in plain values; TimeEntryList maps them onto the wire
// conventions (explicit null vs the "null" string vs an omitted key).

export interface TimeEntryFormValues {
  start_time: string;       // ISO-8601 with offset
  end_time: string | null;  // null = no end / cleared
  hours: number | null;     // null = cleared, fall back to the timer. 0 is a real value.
  billable: boolean;
  notes: string | null;     // null = cleared
}

interface Props {
  initial?: TimeEntry;
  onSubmit: (values: TimeEntryFormValues) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

export default function TimeEntryForm({ initial, onSubmit, onCancel, submitLabel = 'Save' }: Props) {
  const [start, setStart] = useState(
    initial ? toLocalInputValue(initial.start_time) : nowLocalInputValue()
  );
  const [end, setEnd] = useState(toLocalInputValue(initial?.end_time ?? null));
  // Prefilled from the stored override only. Empty means "fall back to the timer".
  const [hours, setHours] = useState(initial?.hours != null ? String(initial.hours) : '');
  const [billable, setBillable] = useState(initial?.billable ?? true);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Once the user types in hours, their value wins for the rest of the edit.
  //
  // A *stored* override starts dirty: `initial.hours` is a value the user
  // already committed, so the timer must never overwrite it (§1 — timer-derived
  // values are defaults, never constraints). Without this, nudging the end time
  // on an entry storing hours: 5 silently rewrote it to the computed duration,
  // and clearing End wiped the override entirely, dropping effective_hours to 0
  // and removing the entry from the next invoice preview.
  const [hoursDirty, setHoursDirty] = useState(initial?.hours != null);
  const firstRender = useRef(true);

  // Prefill hours whenever start/end change and the user has not taken over.
  // Skipped on the initial render so opening an entry that stores no override
  // does not silently turn it into one.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (hoursDirty) return;
    const derived = timerHours(start, end);
    setHours(derived === null ? '' : String(derived));
  }, [start, end]);

  const derived = timerHours(start, end);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!start) {
      setError('Start time is required.');
      return;
    }

    // Empty is checked before Number(), which would turn '' into 0 — the two
    // mean different things: cleared falls back to the timer, 0 is an override.
    const raw = hours.trim();
    let hoursValue: number | null = null;
    if (raw !== '') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError('Hours must be a number of 0 or more, or empty to use the timer.');
        return;
      }
      hoursValue = Math.round(parsed * 100) / 100;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        start_time: toISOWithOffset(start),
        end_time: end ? toISOWithOffset(end) : null,
        hours: hoursValue,
        billable,
        notes: notes.trim() ? notes.trim() : null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Already invoiced — a warning, never a block */}
      {initial?.invoice_number && (
        <p className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
          This entry is on invoice {initial.invoice_number}. You can still edit it — the invoice will
          not update by itself.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-300">
            Start <span className="text-red-400">*</span>
          </label>
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-300">
            End <span className="text-slate-500 font-normal">(optional)</span>
          </label>
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Hours — always editable, whatever the entry's state */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">Hours</label>
        <input
          type="number"
          step="0.25"
          min="0"
          value={hours}
          onChange={(e) => { setHours(e.target.value); setHoursDirty(true); }}
          placeholder={derived !== null ? `${derived} from timer` : 'From timer'}
          className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                     placeholder:text-slate-500
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
        />
        <p className="text-xs text-slate-500">
          Overrides the timer. Leave empty to use the start/end duration
          {derived !== null ? ` (${derived}h)` : ''}.
        </p>
      </div>

      <label className="flex items-center gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={billable}
          onChange={(e) => setBillable(e.target.checked)}
          className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-600
                     focus:ring-2 focus:ring-violet-500 focus:ring-offset-0"
        />
        <span className="text-sm text-slate-300">Billable</span>
      </label>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">
          Notes <span className="text-slate-500 font-normal">(optional)</span>
        </label>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What did you work on?"
          className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                     placeholder:text-slate-500 resize-none
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
        />
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-800 border border-slate-700
                     rounded-lg hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-5 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg
                     hover:bg-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-2"
        >
          {submitting && (
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          )}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
