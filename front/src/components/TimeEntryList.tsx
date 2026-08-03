import { useState, useEffect, useCallback } from 'react';
import type { TimeEntry, CreateTimeEntryPayload, UpdateTimeEntryPayload } from '../types';
import { getSessions, createSession, updateSession, deleteSession } from '../api';
import TimeEntryForm from './TimeEntryForm';
import type { TimeEntryFormValues } from './TimeEntryForm';

interface Props {
  taskId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEntryDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-SG', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Singapore',
  });
}

function formatEntryTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-SG', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore',
  });
}

function newestFirst(list: TimeEntry[]): TimeEntry[] {
  return [...list].sort(
    (a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Time Entries section ──────────────────────────────────────────────────────
// Backed by the `sessions` API. This is NOT the "Sessions" section above it —
// that one is `goals` (AI prompt/output). See InvoicingPlan.md §2.2.

export default function TimeEntryList({ taskId }: Props) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');        // load failure — replaces the list
  const [actionError, setActionError] = useState(''); // delete failure — sits above it
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setEntries(newestFirst(await getSessions({ task_id: taskId })));
    } catch {
      setError('Failed to load time entries.');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  // Reset transient UI when switching task
  useEffect(() => {
    setShowForm(false);
    setEditingId(null);
  }, [taskId]);

  const handleCreate = async (v: TimeEntryFormValues) => {
    // Optional keys are omitted when empty — a new entry simply starts with no
    // end, no hours override and no notes. `hours` is compared against null so
    // an explicit 0 is still sent.
    const payload: CreateTimeEntryPayload = {
      task_id: taskId,
      start_time: v.start_time,
      billable: v.billable,
      ...(v.end_time !== null ? { end_time: v.end_time } : {}),
      ...(v.hours !== null ? { hours: v.hours } : {}),
      ...(v.notes !== null ? { notes: v.notes } : {}),
    };
    const created = await createSession(payload);
    setEntries((prev) => newestFirst([created, ...prev]));
    setShowForm(false);
  };

  const handleUpdate = async (entry: TimeEntry, v: TimeEntryFormValues) => {
    const payload: UpdateTimeEntryPayload = {
      start_time: v.start_time,
      // String fields clear with the literal "null" (repo convention).
      end_time: v.end_time ?? 'null',
      notes: v.notes ?? 'null',
      // hours is numeric: an explicit null clears the override and falls back
      // to the timer; 0 is a real value and must survive as 0.
      hours: v.hours,
      billable: v.billable,
    };
    const updated = await updateSession(entry.id, payload);
    setEntries((prev) => newestFirst(prev.map((e) => (e.id === updated.id ? updated : e))));
    setEditingId(null);
  };

  const handleDelete = async (entry: TimeEntry) => {
    setActionError('');
    try {
      await deleteSession(entry.id);
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    } catch {
      // Shown above the list rather than through `error`, which replaces it.
      setActionError('Failed to delete the time entry.');
    }
  };

  const totalHours = round2(entries.reduce((sum, e) => sum + (e.effective_hours ?? 0), 0));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <p className="text-xs text-slate-500 uppercase tracking-wider">
            Time Entries{entries.length > 0 ? ` (${entries.length})` : ''}
          </p>
          {entries.length > 0 && (
            <span className="text-xs font-medium text-violet-400">{totalHours}h</span>
          )}
        </div>
        <button
          onClick={() => { setShowForm((v) => !v); setEditingId(null); }}
          className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Time Entry
        </button>
      </div>

      {showForm && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-3">
          <TimeEntryForm
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
            submitLabel="Add Time Entry"
          />
        </div>
      )}

      {actionError && (
        <div className="flex items-center justify-between gap-3 mb-2 text-xs text-red-300 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
          <span>{actionError}</span>
          <button
            onClick={() => setActionError('')}
            className="text-red-400/70 hover:text-red-300 transition-colors shrink-0"
            title="Dismiss"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-slate-500">
          <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
          Loading time entries…
        </div>
      ) : error ? (
        <div className="flex items-center gap-3 py-2">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchEntries}
            className="text-xs text-violet-400 hover:text-violet-300 underline transition-colors"
          >
            Retry
          </button>
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-slate-600 py-2">No time entries yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <li key={e.id} className="bg-slate-800 rounded-lg overflow-hidden">
              {editingId === e.id ? (
                <div className="p-3">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-slate-300">Edit Time Entry</span>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                  <TimeEntryForm
                    initial={e}
                    onSubmit={(v) => handleUpdate(e, v)}
                    onCancel={() => setEditingId(null)}
                    submitLabel="Save Changes"
                  />
                </div>
              ) : (
                <div className="px-3 py-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-slate-200 shrink-0">
                      {formatEntryDate(e.start_time)}
                    </span>
                    <span className="text-xs text-slate-500 shrink-0">
                      {formatEntryTime(e.start_time)} → {e.end_time ? formatEntryTime(e.end_time) : 'running'}
                    </span>
                    <span
                      className="text-xs font-medium text-violet-400 shrink-0"
                      title={e.hours != null ? 'Manually set' : 'From the timer'}
                    >
                      {e.effective_hours}h{e.hours != null ? '*' : ''}
                    </span>
                    <div className="ml-auto flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => { setEditingId(e.id); setShowForm(false); }}
                        className="px-1.5 py-0.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-600 rounded transition-colors"
                        title="Edit time entry"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(e)}
                        className="px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded transition-colors"
                        title="Delete time entry"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${
                      e.billable
                        ? 'text-emerald-400 bg-emerald-400/10'
                        : 'text-slate-500 bg-slate-700'
                    }`}>
                      {e.billable ? 'Billable' : 'Non-billable'}
                    </span>
                    {!e.end_time && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                        Running
                      </span>
                    )}
                    {e.invoice_number && (
                      <span
                        className="text-xs font-medium text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full"
                        title="Already on an invoice — still editable"
                      >
                        Invoiced · {e.invoice_number}
                      </span>
                    )}
                  </div>

                  {e.notes && (
                    <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed mt-1.5">{e.notes}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
