// Time Entries — the `sessions` collection, and never called "Sessions"
// anywhere a user can read it. That word belongs to `goals` on the web
// (CLAUDE.md), which this app does not ship.
//
// This file owns the data: the fetches, the filter state, the mutations and the
// wire conventions. Everything visual lives in `src/screens/entries/`.
//
// ── Two fetch pairs, not one ─────────────────────────────────────────────────
//
// The entries refetch whenever a filter changes, because `GET /sessions` does
// the filtering server-side. The reference lists behind the pickers (clients,
// projects, tasks) do not depend on any filter, so they load once and on pull —
// re-reading three unpaginated collections every time a dropdown moves would be
// three needless full-collection reads over mobile data.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import {
  apiErrorMessage,
  createSession,
  deleteSession,
  getClients,
  getProjects,
  getSessions,
  getTasks,
  updateSession,
} from '@/api';
import { Button, ConfirmSheet, EmptyState, ErrorNote, LoadingBlock, Screen } from '@/components';
import { formatHoursLabel } from '@/lib/hours';
import { sgtDayKey } from '@/lib/sgt';
import DayGroup from '@/screens/entries/DayGroup';
import EntryFilters from '@/screens/entries/EntryFilters';
import EntryForm, { type EntryFormValues } from '@/screens/entries/EntryForm';
import {
  claimingInvoices,
  defaultWindow,
  describeWindow,
  formatDayHeading,
  groupByDay,
  totalHours,
  UNDATED,
} from '@/screens/entries/grouping';
import type {
  Client,
  CreateTimeEntryPayload,
  Project,
  Task,
  TimeEntry,
  UpdateTimeEntryPayload,
} from '@/types';

/** What the editor is open on: nothing, a new entry, or an existing one. */
type Editing = { mode: 'new' } | { mode: 'edit'; entry: TimeEntry } | null;

export default function EntriesScreen() {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');

  const [clientId, setClientId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  // Wire timestamps at Singapore midnight — `DateTimeField`'s format. The
  // `YYYY-MM-DD` the API wants is derived below with `sgtDayKey`. Either end may
  // be cleared to "no bound".
  const [range, setRange] = useState<{ from: string | null; to: string | null }>(defaultWindow);
  const { from, to } = range;

  const [editing, setEditing] = useState<Editing>(null);
  // One sheet for the whole list — the entry it is asking about, not a flag per
  // row.
  const [deleteTarget, setDeleteTarget] = useState<TimeEntry | null>(null);

  const dateFrom = sgtDayKey(from);
  const dateTo = sgtDayKey(to);

  // ── Fetching ───────────────────────────────────────────────────────────────

  const loadEntries = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      setError('');
      try {
        const list = await getSessions({
          ...(clientId ? { client_id: clientId } : {}),
          ...(projectId ? { project_id: projectId } : {}),
          ...(dateFrom ? { date_from: dateFrom } : {}),
          ...(dateTo ? { date_to: dateTo } : {}),
        });
        setEntries(list);
      } catch (e: unknown) {
        setError(apiErrorMessage(e, 'Could not load time entries.'));
      } finally {
        setLoading(false);
      }
    },
    [clientId, projectId, dateFrom, dateTo],
  );

  const loadReference = useCallback(async () => {
    try {
      const [c, p, t] = await Promise.all([getClients(), getProjects(), getTasks()]);
      setClients(c);
      setProjects(p);
      setTasks(t);
    } catch (e: unknown) {
      // A softer failure than the list itself: the entries can still be read,
      // the pickers just have less in them.
      setActionError(
        apiErrorMessage(e, 'Could not load clients, projects and tasks. The pickers may be empty.'),
      );
    }
  }, []);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    loadReference();
  }, [loadReference]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setActionError('');
    // Neither rejects — both record their own failure — so nothing here needs a
    // catch to keep the spinner from sticking.
    await Promise.all([loadEntries({ silent: true }), loadReference()]);
    setRefreshing(false);
  }, [loadEntries, loadReference]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const groups = useMemo(() => groupByDay(entries), [entries]);
  const total = useMemo(() => totalHours(entries), [entries]);

  // Offered when logging new time: narrowed the same way the list is, so the
  // picker matches what is on screen. Editing is never narrowed — the entry's
  // own task must always be reachable.
  const selectableTasks = useMemo(() => {
    if (projectId) return tasks.filter((task) => task.project_id === projectId);
    if (clientId) return tasks.filter((task) => task.client_id === clientId);
    return tasks;
  }, [tasks, clientId, projectId]);

  // ── Mutations ──────────────────────────────────────────────────────────────
  //
  // The two clearing conventions, from `MyTrackerFormat.md`:
  //
  //   `end_time`, `notes`  string fields  → the literal string "null" clears
  //   `hours`              numeric field  → a real JSON null clears
  //
  // Getting them the wrong way round fails quietly: a JSON null on `end_time`
  // is read as "key present, value None" by a handler that expects "null", and
  // the string "null" in `hours` is not a number at all.
  //
  // On create there is nothing to clear, so an absent value is simply omitted.

  const handleSubmit = async (values: EntryFormValues) => {
    setActionError('');

    if (editing?.mode === 'edit') {
      const payload: UpdateTimeEntryPayload = {
        task_id: values.task_id,
        start_time: values.start_time,
        end_time: values.end_time ?? 'null',
        notes: values.notes ?? 'null',
        // Explicit null clears the override and hands the entry back to the
        // timer. 0 is a real override of zero hours, not a clear.
        hours: values.hours,
        billable: values.billable,
      };
      await updateSession(editing.entry.id, payload);
    } else {
      const payload: CreateTimeEntryPayload = {
        task_id: values.task_id,
        start_time: values.start_time,
        billable: values.billable,
        ...(values.end_time !== null ? { end_time: values.end_time } : {}),
        ...(values.hours !== null ? { hours: values.hours } : {}),
        ...(values.notes !== null ? { notes: values.notes } : {}),
      };
      await createSession(payload);
    }

    setEditing(null);
    // Refetched rather than spliced in: an edited start time can move an entry
    // out of the filtered window, and a list that disagrees with its own
    // filters is worse than a second round trip.
    await loadEntries({ silent: true });
  };

  // Throws on failure so `ConfirmSheet` reports it in place and stays open.
  const handleDelete = async (entry: TimeEntry) => {
    setActionError('');
    await deleteSession(entry.id);
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const header = (
    <View className="border-b border-slate-800 px-4 pb-3 pt-1">
      <Text className="text-xl font-bold text-slate-100">Time Entries</Text>
      <Text className="mt-0.5 text-xs leading-relaxed text-slate-500">
        Hours logged against tasks. This is what invoices bill from.
      </Text>
      <View className="mt-2 flex-row items-baseline gap-2">
        <Text className="text-lg font-semibold tabular-nums text-slate-100">
          {formatHoursLabel(total)}
        </Text>
        <Text className="min-w-0 flex-1 text-xs text-slate-500" numberOfLines={1}>
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'} · {describeWindow(from, to)}
        </Text>
      </View>
    </View>
  );

  const footer = (
    <View className="border-t border-slate-800 px-4 py-3">
      <Button label="+ Log time" onPress={() => setEditing({ mode: 'new' })} testID="log-time" />
    </View>
  );

  return (
    <Screen header={header} footer={footer} refreshing={refreshing} onRefresh={handleRefresh}>
      <EntryFilters
        clients={clients}
        projects={projects}
        clientId={clientId}
        projectId={projectId}
        from={from}
        to={to}
        onChangeClient={(value) => {
          setClientId(value);
          // The chosen project may not belong to the new client.
          setProjectId(null);
        }}
        onChangeProject={setProjectId}
        onChangeFrom={(value) => setRange((prev) => ({ ...prev, from: value }))}
        onChangeTo={(value) => setRange((prev) => ({ ...prev, to: value }))}
        onReset={() => {
          setClientId(null);
          setProjectId(null);
          setRange(defaultWindow());
        }}
      />

      {actionError ? <ErrorNote message={actionError} onRetry={handleRefresh} /> : null}

      {loading ? (
        <LoadingBlock label="Loading time entries…" />
      ) : error ? (
        <ErrorNote message={error} onRetry={() => loadEntries()} />
      ) : groups.length === 0 ? (
        <EmptyState
          title="No time entries here"
          subtitle={`Nothing logged in ${describeWindow(from, to)}. Widen the dates, or log time against a task.`}
          actionLabel="Log time"
          onAction={() => setEditing({ mode: 'new' })}
        />
      ) : (
        <View className="gap-5">
          {groups.map((group) => (
            <DayGroup
              key={group.day}
              day={group.day}
              entries={group.entries}
              hours={group.hours}
              onEdit={(entry) => setEditing({ mode: 'edit', entry })}
              onDelete={setDeleteTarget}
            />
          ))}
        </View>
      )}

      {editing ? (
        <EntryForm
          // Remounts when the target changes, so the fields never carry over
          // from the previously edited entry.
          key={editing.mode === 'edit' ? editing.entry.id : 'new'}
          entry={editing.mode === 'edit' ? editing.entry : null}
          tasks={editing.mode === 'edit' ? tasks : selectableTasks}
          taskHint={
            editing.mode === 'new' && selectableTasks.length !== tasks.length
              ? 'Narrowed by the client and project filters above.'
              : undefined
          }
          onSubmit={handleSubmit}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmSheet
          open
          title="Delete time entry"
          message={`Delete ${deleteTarget.task_title} — ${formatDayHeading(
            sgtDayKey(deleteTarget.start_time) ?? UNDATED,
          )}, ${formatHoursLabel(deleteTarget.effective_hours)}?`}
          // Already-billed hours are the case worth spelling out. The server's
          // delete does not touch invoices, so the invoice keeps what it was
          // saved with — this warns, it does not stop you.
          detail={
            claimingInvoices(deleteTarget).length > 0
              ? `These hours are billed on ${claimingInvoices(deleteTarget).join(
                  ', ',
                )}. That invoice keeps the totals it was saved with, but regenerating it will no longer find this entry.`
              : undefined
          }
          onConfirm={() => handleDelete(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </Screen>
  );
}
