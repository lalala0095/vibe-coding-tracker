// Trackers — every work block, not just the one that is running.
//
// The Now tab owns the *current* block: start it, watch it tick, stop it, add
// tasks, turn it into time entries. This screen is the list and the history —
// what happened last Tuesday, and everything that can be done to it afterwards.
//
// Nothing from the Now tab is reimplemented here. `AddTasksSheet` and
// `BillTrackerSheet` are imported from `src/screens/now/` and given a different
// tracker; both were already written as functions of the tracker they are
// handed, so the paste-bulk parser, the even/full split and the "already
// billed" warning exist once in this app, not twice. `elapsedHours`, `isFuture`
// and `nameMoment` come from `src/screens/now/trackerTime.ts` for the same
// reason. (Their `Sheet` shell says it is scoped to `now/` until someone who
// owns `src/components/` promotes it — this screen borrows it rather than
// copying it, and that promotion is still worth doing.)
//
// ── The two rules this file is where they are kept ───────────────────────────
//
// 1. **No `.toISOString()`.** Every timestamp written here comes out of a
//    `DateTimeField` or `nowSgt()`, both of which emit Singapore wall-clock
//    with an explicit `+08:00`. `front/src/pages/TrackersPage.tsx:1264` writes
//    UTC with a `Z`, which dates a block stopped between midnight and 08:00 SGT
//    a day early — and a wrong date there flows into an invoice period. That
//    defect stops at the edge of this file.
//
// 2. **Time Entries, never "Sessions".** `billTracker` writes to the `sessions`
//    collection, which is called Time Entries everywhere a user can see it.
//
// ── Clearing `end_time` and `notes` ──────────────────────────────────────────
//
// Both are **string** fields, so `MyTrackerFormat.md` → "Clearing optional
// fields on update" applies: the literal string `"null"` clears them.
// `back/routers/trackers.py:446` tests `payload.end_time.lower() == "null"` and
// writes `None`; a real JSON `null` would instead fail the `is not None` guard
// above it and be silently ignored, leaving the old value in place.
//
// On **create** the sentinel is not honoured at all — `create_tracker` writes
// `payload.end_time` straight to Firestore, so `"null"` would be stored as the
// four characters `null` and the tracker would read as stopped at a timestamp
// that is not one. So: omitted on create, `"null"` on update. Both directions
// are applied in `handleCreate`/`handleUpdate` below and nowhere else.
//
// Clearing `end_time` is what **restarts** a tracker: a block with no end time
// is a block that is still running. There is no status field.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Stack } from 'expo-router';
import { Text, View } from 'react-native';

import {
  addTasksToTracker,
  apiErrorMessage,
  billTracker,
  createTasksBulk,
  createTracker,
  deleteTracker,
  getProjects,
  getSessions,
  getTrackerSettings,
  getTrackers,
  removeTaskFromTracker,
  updateTracker,
} from '@/api';
import {
  Button,
  Chip,
  ConfirmSheet,
  EmptyState,
  ErrorNote,
  LoadingBlock,
  Screen,
} from '@/components';
import { formatHoursLabel } from '@/lib/hours';
import AddTasksSheet from '@/screens/now/AddTasksSheet';
import BillTrackerSheet from '@/screens/now/BillTrackerSheet';
import { useTick } from '@/screens/now/useTick';
import { trackerDeletionDetail, trackerDeletionMessage } from '@/screens/trackers/deletion';
import TrackerFormSheet, { type TrackerFormValues } from '@/screens/trackers/TrackerFormSheet';
import TrackerRow from '@/screens/trackers/TrackerRow';
import {
  filterTrackers,
  isRunning,
  sortByStartDesc,
  TRACKER_FILTERS,
  totalHours,
  type TrackerFilter,
} from '@/screens/trackers/trackerRows';
import type {
  BillTrackerPayload,
  Project,
  Session,
  Tracker,
  TrackerSettings,
  TrackerTaskRef,
} from '@/types';

/**
 * The header for this route.
 *
 * `app/_layout.tsx` shows a header only for route names it has a title for, and
 * that map is in a file this screen does not own. Options set from inside a
 * route are layered over the layout's `screenOptions`, so this is where the
 * title and the back button come from.
 *
 * Hoisted rather than written inline because `<Stack.Screen>` calls
 * `navigation.setOptions` from a layout effect keyed on the object itself
 * (`expo-router/build/views/Screen.js`) — and this screen re-renders once a
 * second while a tracker is running.
 */
const SCREEN_OPTIONS = { headerShown: true, title: 'Trackers' };

/** What the tracker form is open on. */
type Editing = { mode: 'new' } | { mode: 'edit'; tracker: Tracker } | null;

/** The task being removed, and the block it is being removed from. */
type RemoveTarget = { tracker: Tracker; task: TrackerTaskRef } | null;

export default function TrackersScreen() {
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  // Only for `AddTasksSheet`'s project picker — the sheet does its own task
  // fetching, but takes the project list from its caller.
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<TrackerSettings | null>(null);
  // Time entries per tracker id. `null` is "not loaded", which the delete
  // confirmation renders differently from a real zero.
  const [entryCounts, setEntryCounts] = useState<Record<string, number> | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [filter, setFilter] = useState<TrackerFilter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [editing, setEditing] = useState<Editing>(null);
  // The sheets hold an **id**, not a tracker: adding or removing a task returns
  // a new tracker document, and a sheet holding the old object would keep
  // showing the task it just removed.
  const [tasksTargetId, setTasksTargetId] = useState<string | null>(null);
  const [billTargetId, setBillTargetId] = useState<string | null>(null);
  // The delete target is the object, because it has to outlive its own removal
  // from `trackers` — the same reason `TrackersPage.tsx:1197` keeps one.
  const [deleteTarget, setDeleteTarget] = useState<Tracker | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget>(null);

  // ── Fetching ───────────────────────────────────────────────────────────────

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    setError('');
    try {
      // Every tracker, filtered on the phone: the three filters switch often
      // enough that a round trip per tap would be worse than one list, and the
      // endpoint is unpaginated either way.
      const [trackerList, projectList] = await Promise.all([getTrackers(), getProjects()]);
      setTrackers(sortByStartDesc(trackerList));
      setProjects(projectList);
    } catch (e: unknown) {
      setError(apiErrorMessage(e, 'Could not load trackers.'));
    } finally {
      setLoading(false);
    }
  }, []);

  // Best-effort, exactly as on the Now screen: the auto-name template is a
  // convenience, and a settings hiccup must not stand between the owner and a
  // new tracker. A failure costs the pre-filled title and nothing else.
  const loadSettings = useCallback(async () => {
    try {
      setSettings(await getTrackerSettings());
    } catch {
      setSettings(null);
    }
  }, []);

  // Also best-effort: this only sharpens a delete confirmation, and
  // `deletion.ts` already has copy for the unknown case. One list of entries
  // gives the count for every tracker at once.
  const loadEntryCounts = useCallback(async () => {
    try {
      const entries = await getSessions();
      const counts: Record<string, number> = {};
      for (const entry of entries) {
        if (entry.tracker_id) counts[entry.tracker_id] = (counts[entry.tracker_id] ?? 0) + 1;
      }
      setEntryCounts(counts);
    } catch {
      setEntryCounts(null);
    }
  }, []);

  useEffect(() => {
    load();
    loadSettings();
    loadEntryCounts();
  }, [load, loadSettings, loadEntryCounts]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    // None of the three rejects — each records its own failure — so nothing
    // here needs a catch to keep the spinner from sticking.
    await Promise.all([load({ silent: true }), loadSettings(), loadEntryCounts()]);
    setRefreshing(false);
  }, [load, loadSettings, loadEntryCounts]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const visible = useMemo(() => filterTrackers(trackers, filter), [trackers, filter]);

  // One interval for the whole list, stopped when the screen loses focus — and
  // not started at all unless a row on screen is actually counting. Under the
  // "Done" filter every duration is fixed, so a frozen clock is the right one.
  const ticking = useMemo(() => visible.some(isRunning), [visible]);
  const now = useTick(ticking);
  const runningCount = useMemo(() => trackers.filter(isRunning).length, [trackers]);
  // Wall-clock hours, for display under a filter. Not billable time — a
  // tracker's hours only become billable once they are turned into time
  // entries, and the server computes those.
  const total = totalHours(visible, now);

  const tasksTarget = useMemo(
    () => trackers.find((tracker) => tracker.id === tasksTargetId) ?? null,
    [trackers, tasksTargetId],
  );
  const billTarget = useMemo(
    () => trackers.find((tracker) => tracker.id === billTargetId) ?? null,
    [trackers, billTargetId],
  );

  /**
   * Time entries created from a tracker, or `null` when the lookup has not
   * landed. A tracker absent from a *loaded* map has zero, which the
   * confirmation words differently from not knowing.
   */
  const entryCountFor = (trackerId: string): number | null =>
    entryCounts ? (entryCounts[trackerId] ?? 0) : null;

  const applyTracker = useCallback((updated: Tracker) => {
    // Re-sorted rather than spliced in place: an edited start time moves a row.
    setTrackers((prev) =>
      sortByStartDesc(prev.map((tracker) => (tracker.id === updated.id ? updated : tracker))),
    );
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────────
  //
  // The two clearing conventions are applied here and nowhere else — see the
  // block comment at the top of the file. The form emits plain values where
  // `null` means "empty"; translating that into the right wire shape is this
  // layer's job.

  const handleCreate = async (values: TrackerFormValues) => {
    const created = await createTracker({
      title: values.title,
      start_time: values.start_time,
      // Omitted when empty. `create_tracker` stores what it is given verbatim,
      // so the string "null" would become a literal end time of four letters.
      ...(values.end_time !== null ? { end_time: values.end_time } : {}),
      ...(values.notes !== null ? { notes: values.notes } : {}),
    });
    setTrackers((prev) => sortByStartDesc([created, ...prev]));
  };

  const handleUpdate = async (tracker: Tracker, values: TrackerFormValues) => {
    applyTracker(
      await updateTracker(tracker.id, {
        title: values.title,
        start_time: values.start_time,
        // String fields: the literal "null" is what clears them on update.
        // Clearing `end_time` is what puts the tracker back to running.
        end_time: values.end_time ?? 'null',
        notes: values.notes ?? 'null',
      }),
    );
  };

  // Throws on failure so `ConfirmSheet` reports it in place and stays open,
  // rather than dropping a row that is still in the database.
  const handleDelete = async (tracker: Tracker) => {
    await deleteTracker(tracker.id);
    setTrackers((prev) => prev.filter((t) => t.id !== tracker.id));
    // The time entries created from it are deliberately left alone — the
    // delete does not cascade, which is what the confirmation just said.
  };

  const handleAddTasks = async (taskIds: string[]) => {
    if (!tasksTarget) return;
    applyTracker(await addTasksToTracker(tasksTarget.id, taskIds));
  };

  // Pasted titles become real tasks first, then get attached. Both calls have
  // to land, so nothing is caught here — the sheet stays open and says what
  // failed.
  const handleCreateTasks = async (projectId: string, titles: string[]) => {
    if (!tasksTarget) return;
    const created = await createTasksBulk({ project_id: projectId, titles });
    applyTracker(
      await addTasksToTracker(
        tasksTarget.id,
        created.map((task) => task.id),
      ),
    );
  };

  const handleRemoveTask = async (tracker: Tracker, taskId: string) => {
    applyTracker(await removeTaskFromTracker(tracker.id, taskId));
  };

  const handleBill = async (payload: BillTrackerPayload): Promise<Session[]> => {
    if (!billTarget) return [];
    const created = await billTracker(billTarget.id, payload);
    // An empty array is a normal outcome — every task on the tracker had
    // already been billed from it — and the sheet says so itself. Either way
    // the counts behind the delete confirmation have moved.
    loadEntryCounts();
    return created;
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const header = (
    <View className="border-b border-slate-800 px-4 pb-3 pt-1">
      <Text className="text-xl font-bold text-slate-100">Trackers</Text>
      <Text className="mt-0.5 text-xs leading-relaxed text-slate-500">
        Blocks of work, newest first. The one you are in right now lives on the Now tab.
      </Text>

      <View className="mt-2 flex-row items-baseline gap-2">
        <Text className="text-lg font-semibold tabular-nums text-slate-100">
          {formatHoursLabel(total)}
        </Text>
        <Text className="min-w-0 flex-1 text-xs text-slate-500" numberOfLines={1}>
          {visible.length} {visible.length === 1 ? 'block' : 'blocks'}
          {runningCount > 0 ? ` · ${runningCount} running` : ''}
        </Text>
      </View>

      <View className="mt-2 flex-row flex-wrap gap-2">
        {TRACKER_FILTERS.map(([value, label]) => {
          const active = value === filter;
          return (
            <Chip
              key={value}
              label={label}
              size="md"
              tone={active ? 'violet' : 'slate'}
              className={active ? '' : 'opacity-60'}
              onPress={() => setFilter(value)}
              testID={`trackers-filter-${value}`}
            />
          );
        })}
      </View>
    </View>
  );

  const footer = (
    <View className="border-t border-slate-800 px-4 py-3">
      <Button
        label="+ New tracker"
        onPress={() => setEditing({ mode: 'new' })}
        testID="new-tracker"
      />
    </View>
  );

  return (
    <>
      {/* Renders nothing; it only sets this route's options. See above. */}
      <Stack.Screen options={SCREEN_OPTIONS} />

      <Screen header={header} footer={footer} refreshing={refreshing} onRefresh={handleRefresh}>
        {loading ? (
          <LoadingBlock label="Loading trackers…" />
        ) : error ? (
          <ErrorNote message={error} onRetry={() => load()} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={
              trackers.length === 0
                ? 'No trackers yet'
                : filter === 'running'
                  ? 'Nothing is running'
                  : 'Nothing finished yet'
            }
            subtitle={
              trackers.length === 0
                ? 'A tracker is a block of work: it starts, it collects tasks, and its time becomes time entries at the end.'
                : filter === 'running'
                  ? 'Every block here has an end time. Start one on the Now tab, or create one with its times filled in.'
                  : 'Every block here is still running. Give one an end time and it lands in this list.'
            }
            actionLabel="New tracker"
            onAction={() => setEditing({ mode: 'new' })}
          />
        ) : (
          <View className="gap-3">
            {visible.map((tracker) => (
              <TrackerRow
                key={tracker.id}
                tracker={tracker}
                now={now}
                expanded={expanded[tracker.id] ?? false}
                onToggle={() =>
                  setExpanded((prev) => ({ ...prev, [tracker.id]: !(prev[tracker.id] ?? false) }))
                }
                onEdit={() => setEditing({ mode: 'edit', tracker })}
                onAddTasks={() => setTasksTargetId(tracker.id)}
                onBill={() => setBillTargetId(tracker.id)}
                onDelete={() => setDeleteTarget(tracker)}
                onRemoveTask={(task) => setRemoveTarget({ tracker, task })}
              />
            ))}
          </View>
        )}

        {/*
          Every sheet is mounted only while open, so each opening is a fresh one —
          which is what lets the form render its auto-name for the moment you
          opened it and the billing sheet snapshot the span at that instant.
        */}
        {editing ? (
          <TrackerFormSheet
            open
            // Remounts when the target changes, so fields never carry over from
            // the tracker edited before this one.
            key={editing.mode === 'edit' ? editing.tracker.id : 'new'}
            tracker={editing.mode === 'edit' ? editing.tracker : null}
            settings={settings}
            onSubmit={(values) =>
              editing.mode === 'edit' ? handleUpdate(editing.tracker, values) : handleCreate(values)
            }
            onClose={() => setEditing(null)}
          />
        ) : null}

        {tasksTarget ? (
          <AddTasksSheet
            open
            tracker={tasksTarget}
            projects={projects}
            onClose={() => setTasksTargetId(null)}
            onAdd={handleAddTasks}
            onCreate={handleCreateTasks}
          />
        ) : null}

        {billTarget ? (
          <BillTrackerSheet
            open
            tracker={billTarget}
            onClose={() => setBillTargetId(null)}
            onBill={handleBill}
          />
        ) : null}

        {deleteTarget ? (
          <ConfirmSheet
            open
            title="Delete tracker"
            message={trackerDeletionMessage(deleteTarget)}
            detail={trackerDeletionDetail(deleteTarget, entryCountFor(deleteTarget.id))}
            onConfirm={() => handleDelete(deleteTarget)}
            onClose={() => setDeleteTarget(null)}
            errorFallback="Could not delete the tracker. Try again."
          />
        ) : null}

        {removeTarget ? (
          <ConfirmSheet
            open
            title="Remove from this block?"
            message={`"${removeTarget.task.task_title}" will no longer be part of "${removeTarget.tracker.title}".`}
            detail="The task itself is not deleted, and any time entries already created from this tracker are left alone."
            confirmLabel="Remove"
            onConfirm={() => handleRemoveTask(removeTarget.tracker, removeTarget.task.task_id)}
            onClose={() => setRemoveTarget(null)}
            errorFallback="Could not remove the task. Try again."
          />
        ) : null}
      </Screen>
    </>
  );
}
