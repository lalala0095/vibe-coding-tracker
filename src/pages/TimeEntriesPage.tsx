import { useCallback, useEffect, useMemo, useState } from 'react';
import AppNav from '../components/AppNav';
import TimeEntryForm, { type TimeEntryFormValues } from '../components/TimeEntryForm';
import ConfirmDialog from '../components/ConfirmDialog';
import {
  getSessions, createSession, updateSession, deleteSession,
  getClients, getProjects, getTasks,
} from '../api';
import type {
  TimeEntry, CreateTimeEntryPayload, UpdateTimeEntryPayload,
  Client, Project, Task,
} from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function newestFirst(entries: TimeEntry[]): TimeEntry[] {
  return [...entries].sort((a, b) => b.start_time.localeCompare(a.start_time));
}

/** Date portion of an ISO timestamp. Everything is written in SGT already. */
function entryDate(iso: string): string {
  return iso.slice(0, 10);
}

function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-SG', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const hhmm = iso.slice(11, 16);
  return hhmm || '—';
}

/**
 * Invoices claiming an entry. The list is the truth; the scalar is only a
 * fallback for documents written before the list existed (types.ts:178).
 */
function claimingInvoices(entry: TimeEntry): string[] {
  if (entry.invoice_numbers?.length) return entry.invoice_numbers;
  return entry.invoice_number ? [entry.invoice_number] : [];
}

const FIELD =
  'bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TimeEntriesPage() {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');

  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');

  const [adding, setAdding] = useState(false);
  const [newTaskId, setNewTaskId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  // One dialog for the whole list — the entry it is asking about, not a flag
  // per row.
  const [deleteTarget, setDeleteTarget] = useState<TimeEntry | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [e, c, p, t] = await Promise.all([
        getSessions(), getClients(), getProjects(), getTasks(),
      ]);
      setEntries(newestFirst(e));
      setClients(c);
      setProjects(p);
      setTasks(t);
    } catch {
      setError('Failed to load time entries.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Narrowing the client narrows the project choices with it.
  const visibleProjects = clientId
    ? projects.filter((p) => p.client_id === clientId)
    : projects;

  const selectableTasks = useMemo(() => {
    let list = tasks;
    if (projectId) list = list.filter((t) => t.project_id === projectId);
    else if (clientId) list = list.filter((t) => t.client_id === clientId);
    return list;
  }, [tasks, clientId, projectId]);

  const visible = useMemo(() => {
    let list = entries;
    if (clientId) list = list.filter((e) => e.client_id === clientId);
    if (projectId) list = list.filter((e) => e.project_id === projectId);
    return list;
  }, [entries, clientId, projectId]);

  // Group by day for readability — invoices bill by date, so the day is the
  // unit that matters when checking your own work.
  const byDay = useMemo(() => {
    const groups = new Map<string, TimeEntry[]>();
    for (const e of visible) {
      const day = entryDate(e.start_time);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push(e);
    }
    return [...groups.entries()];
  }, [visible]);

  const totalHours = visible.reduce((sum, e) => sum + (e.effective_hours ?? 0), 0);

  // ── Mutations — wire conventions match TimeEntryList exactly ──

  const handleCreate = async (v: TimeEntryFormValues) => {
    const payload: CreateTimeEntryPayload = {
      task_id: newTaskId,
      start_time: v.start_time,
      billable: v.billable,
      ...(v.end_time !== null ? { end_time: v.end_time } : {}),
      ...(v.hours !== null ? { hours: v.hours } : {}),
      ...(v.notes !== null ? { notes: v.notes } : {}),
    };
    const created = await createSession(payload);
    setEntries((prev) => newestFirst([created, ...prev]));
    setAdding(false);
    setNewTaskId('');
  };

  const handleUpdate = async (entry: TimeEntry, v: TimeEntryFormValues) => {
    const payload: UpdateTimeEntryPayload = {
      start_time: v.start_time,
      // String fields clear with the literal "null" (repo convention).
      end_time: v.end_time ?? 'null',
      notes: v.notes ?? 'null',
      // Numeric: explicit null clears the override; 0 is a real value.
      hours: v.hours,
      billable: v.billable,
    };
    const updated = await updateSession(entry.id, payload);
    setEntries((prev) => newestFirst(prev.map((e) => (e.id === updated.id ? updated : e))));
    setEditingId(null);
  };

  // Throws on failure so the dialog reports it in place and stays open; the
  // page banner is left for the other actions.
  const handleDelete = async (entry: TimeEntry) => {
    setActionError('');
    try {
      await deleteSession(entry.id);
    } catch {
      throw new Error('Failed to delete the time entry. It is still here — try again.');
    }
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
  };

  return (
    <div className="min-h-screen bg-slate-950">
      <AppNav active="time" wide />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-100">Time Entries</h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Hours logged against tasks. This is what invoices bill from —
              trackers are a separate, non-billable grouping.
            </p>
          </div>
          <button
            onClick={() => { setAdding((v) => !v); setEditingId(null); }}
            className="shrink-0 px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg
                       hover:bg-violet-500 transition-colors"
          >
            {adding ? 'Cancel' : '+ Log time'}
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-6">
          <select
            value={clientId}
            onChange={(e) => { setClientId(e.target.value); setProjectId(''); }}
            className={FIELD}
          >
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={FIELD}
          >
            <option value="">All projects</option>
            {visibleProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="ml-auto self-center text-sm text-slate-400">
            <span className="text-slate-100 font-semibold">{totalHours.toFixed(2)}</span> h
            <span className="text-slate-500"> · {visible.length} {visible.length === 1 ? 'entry' : 'entries'}</span>
          </div>
        </div>

        {/* Add form */}
        {adding && (
          <div className="mb-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
            <label className="text-sm font-medium text-slate-300 block mb-1.5">Task</label>
            <select
              value={newTaskId}
              onChange={(e) => setNewTaskId(e.target.value)}
              className={`${FIELD} w-full mb-4`}
            >
              <option value="">Select a task…</option>
              {selectableTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.client_name} / {t.project_name} — {t.title}
                </option>
              ))}
            </select>

            {newTaskId ? (
              <TimeEntryForm
                onSubmit={handleCreate}
                onCancel={() => { setAdding(false); setNewTaskId(''); }}
                submitLabel="Log time"
              />
            ) : (
              <p className="text-xs text-slate-500">
                {selectableTasks.length === 0
                  ? 'No tasks available. Create a task first, under Tasks.'
                  : 'Choose the task these hours belong to.'}
              </p>
            )}
          </div>
        )}

        {actionError && (
          <p className="mb-4 text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
            {actionError}
          </p>
        )}

        {/* List */}
        {loading ? (
          <div className="flex items-center gap-3 py-12">
            <span className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">Loading time entries…</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center py-12 gap-3">
            <p className="text-red-400 text-sm">{error}</p>
            <button onClick={fetchAll} className="text-sm text-violet-400 hover:text-violet-300 underline">
              Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl py-12 px-6 text-center">
            <p className="text-slate-300 font-medium">No time entries</p>
            <p className="text-slate-500 text-sm mt-1">
              Log time against a task and it becomes billable on an invoice.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {byDay.map(([day, dayEntries]) => {
              const dayHours = dayEntries.reduce((s, e) => s + (e.effective_hours ?? 0), 0);
              return (
                <div key={day}>
                  <div className="flex items-baseline justify-between mb-2">
                    <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      {formatDay(day)}
                    </h2>
                    <span className="text-xs text-slate-500">{dayHours.toFixed(2)} h</span>
                  </div>

                  <div className="bg-slate-900 border border-slate-800 rounded-xl divide-y divide-slate-800 overflow-hidden">
                    {dayEntries.map((e) => (
                      <div key={e.id} className="px-4 py-3">
                        {editingId === e.id ? (
                          <div className="py-1">
                            <p className="text-xs text-slate-400 mb-3">
                              {e.client_name} / {e.project_name} — {e.task_title}
                            </p>
                            <TimeEntryForm
                              initial={e}
                              onSubmit={(v) => handleUpdate(e, v)}
                              onCancel={() => setEditingId(null)}
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-slate-100 truncate">{e.task_title}</p>
                              <p className="text-xs text-slate-500 truncate">
                                {e.client_name} / {e.project_name}
                                {' · '}{formatTime(e.start_time)}
                                {e.end_time ? `–${formatTime(e.end_time)}` : ' · running'}
                              </p>
                              {e.notes && (
                                <p className="text-xs text-slate-400 mt-1 whitespace-pre-wrap">{e.notes}</p>
                              )}
                            </div>

                            <div className="shrink-0 flex items-center gap-2">
                              {!e.billable && (
                                <span className="text-xs text-slate-500 bg-slate-800 rounded-full px-2 py-0.5">
                                  Non-billable
                                </span>
                              )}
                              {e.invoice_numbers?.length > 0 && (
                                <span
                                  className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-full px-2 py-0.5"
                                  title={`On ${e.invoice_numbers.join(', ')}`}
                                >
                                  Invoiced · {e.invoice_numbers.join(', ')}
                                </span>
                              )}
                              <span className="text-sm text-slate-100 font-medium tabular-nums w-16 text-right">
                                {(e.effective_hours ?? 0).toFixed(2)} h
                              </span>
                              <button
                                onClick={() => { setEditingId(e.id); setAdding(false); }}
                                className="px-2.5 py-1 text-xs rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-white transition-colors"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => setDeleteTarget(e)}
                                className="px-2.5 py-1 text-xs rounded-lg bg-slate-800 border border-slate-700 text-red-400 hover:text-red-300 transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {deleteTarget && (
        <ConfirmDialog
          open
          title="Delete time entry"
          message={
            <>
              Delete{' '}
              <span className="text-slate-100 font-medium">{deleteTarget.task_title}</span>
              {' — '}
              {formatDay(entryDate(deleteTarget.start_time))},{' '}
              {(deleteTarget.effective_hours ?? 0).toFixed(2)} h?
            </>
          }
          // Billed hours are the case worth a warning. The invoice keeps its
          // snapshotted line either way (the server's delete does not touch
          // invoices) — we warn, we do not block.
          detail={
            claimingInvoices(deleteTarget).length > 0
              ? `These hours are billed on ${claimingInvoices(deleteTarget).join(', ')}. That invoice keeps the totals it was saved with, but regenerating it will no longer find this entry.`
              : undefined
          }
          onConfirm={() => handleDelete(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
