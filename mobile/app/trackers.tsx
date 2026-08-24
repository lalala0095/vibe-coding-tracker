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
// ── The Weekly summary tab ───────────────────────────────────────────────────
//
// The second tab is the same summary the web's `TrackersPage` shows, over the
// same arithmetic: `src/lib/week.ts` and `src/lib/weeklySummary.ts` are copies
// of the web's, so the phone and the browser cannot quote different money for
// the same week. Nothing is computed here — this file gathers the six inputs
// `summariseWeeks` asks for and hands them over.
//
// Four of the six were already on this screen. In particular `getSessions()`
// was already being called on mount, counted per tracker for the delete
// confirmation, and then thrown away; the entries are kept now, so the summary
// costs no extra request for the hours it is made of. Only clients and invoice
// settings are new, and they are fetched the first time the tab is opened, so
// the Trackers tab costs exactly what it cost before this tab existed.
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
import { Pressable, Text, View } from 'react-native';

import {
  addTasksToTracker,
  apiErrorMessage,
  billTracker,
  createTasksBulk,
  createTracker,
  deleteTracker,
  getClients,
  getInvoiceSettings,
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
import { recentWeekStarts } from '@/lib/week';
import { summariseWeeks } from '@/lib/weeklySummary';
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
import WeeklySummaryView from '@/screens/trackers/WeeklySummaryView';
import type {
  BillTrackerPayload,
  Client,
  InvoiceSettings,
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

/**
 * The two tabs. `trackers` is everything this screen has always been; `weekly`
 * swaps the body for the summary and leaves the rest of the screen alone.
 */
const SCREEN_TABS = [
  ['trackers', 'Trackers'],
  ['weekly', 'Weekly summary'],
] as const;

type ScreenTab = (typeof SCREEN_TABS)[number][0];

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
  // Every time entry, not a count of them. `null` is "not loaded", which the
  // delete confirmation renders differently from a real zero — the counts it
  // reads are derived from this below, so that distinction survives.
  //
  // The list is kept whole because the weekly summary is made of it: one
  // `getSessions()` on mount now answers both "how many entries came from this
  // tracker" and "what were these twelve weeks worth". It is deliberately
  // unfiltered — `summariseWeeks` decides a tracker was never billed by looking
  // for its id across *every* entry, and a `date_from` would narrow that to the
  // window and start flagging old blocks that were billed long ago.
  const [entries, setEntries] = useState<Session[] | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [tab, setTab] = useState<ScreenTab>('trackers');
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

  // ── Weekly summary state ───────────────────────────────────────────────────
  //
  // Kept apart from `loading`/`error` above, which belong to the tracker list:
  // a failed time-entry fetch must not blank the Trackers tab, and a failed
  // tracker fetch must not be reported as a broken summary.

  const [weekCount, setWeekCount] = useState(12);
  // The rest of the rate chain. `clients` and `invoiceSettings` are only ever
  // read by the summary, which is why neither is in `load()` — a client outage
  // must not cost the user their tracker list.
  const [clients, setClients] = useState<Client[]>([]);
  // Note the name: `settings` above is the *tracker* settings (the auto-name
  // template). These are the invoice settings, the last link in the rate chain,
  // and the two must never be conflated.
  const [invoiceSettings, setInvoiceSettings] = useState<InvoiceSettings | null>(null);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [ratesLoading, setRatesLoading] = useState(false);
  // Fatal for the summary: with no entries there are no hours to report.
  const [entriesError, setEntriesError] = useState('');
  // Non-fatal: a rate fell back a level, but every figure still renders.
  const [rateNote, setRateNote] = useState('');
  // Lazy, and only ever set: the two extra requests are paid the first time the
  // tab is opened and never again. Switching back and forth costs nothing.
  const [weeklyOpened, setWeeklyOpened] = useState(false);

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

  // One list of entries serves two readers, and it fails differently for each.
  //
  // For the delete confirmation it stays best-effort, exactly as before: the
  // count only sharpens the wording and `deletion.ts` already has copy for the
  // unknown case, so a failure leaves `entries` null and nothing is said.
  //
  // For the summary a failure is fatal — there are no hours without entries —
  // so the message is kept in `entriesError` for the weekly body to show. The
  // Trackers tab never reads it, which is why this can be both at once.
  const loadEntries = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setEntriesLoading(true);
    setEntriesError('');
    try {
      setEntries(await getSessions());
    } catch (e: unknown) {
      setEntries(null);
      setEntriesError(apiErrorMessage(e, 'Could not load time entries.'));
    } finally {
      setEntriesLoading(false);
    }
  }, []);

  /**
   * Clients and invoice settings — the rest of the rate chain.
   *
   * Neither is fatal, but neither is swallowed either. `getTrackerSettings()`
   * above can fail in silence because it costs a pre-filled title; losing a
   * link of the rate chain silently *changes money*. So the summary still
   * renders with what did arrive — `settings: null` makes every rate that would
   * have come from settings fall back to "No rate set" rather than to a
   * plausible wrong number — and `rateNote` says so out loud above it.
   *
   * Sequential, not `Promise.all`: each has its own fallback and its own
   * sentence, and the two notes are joined into one so a double outage reads as
   * one message instead of overwriting itself.
   */
  const loadRates = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setRatesLoading(true);
    const notes: string[] = [];
    try {
      setClients(await getClients());
    } catch {
      setClients([]);
      notes.push('Clients could not be loaded, so no client default rate is applied.');
    }
    try {
      setInvoiceSettings(await getInvoiceSettings());
    } catch {
      setInvoiceSettings(null);
      notes.push(
        'Invoice settings could not be loaded, so any rate that falls back to them reads as “No rate set”.',
      );
    }
    setRateNote(notes.length > 0 ? `${notes.join(' ')} The hours are unaffected.` : '');
    setRatesLoading(false);
  }, []);

  useEffect(() => {
    load();
    loadSettings();
    loadEntries();
  }, [load, loadSettings, loadEntries]);

  // Runs once, on the first opening of the Weekly tab. `loadRates` has no
  // dependencies, so `weeklyOpened` going true is the only thing that fires it.
  useEffect(() => {
    if (weeklyOpened) loadRates();
  }, [weeklyOpened, loadRates]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    // None of these reject — each records its own failure — so nothing here
    // needs a catch to keep the spinner from sticking. All are silent: the
    // pull's own spinner is the feedback, and swapping a body that is already
    // on screen for a loading block would be a step backwards.
    await Promise.all([
      load({ silent: true }),
      loadSettings(),
      loadEntries({ silent: true }),
      // Only once the summary has actually been opened — before that there is
      // nothing loaded to refresh, and a pull on the Trackers tab must not
      // start paying for a tab the user has never visited.
      ...(weeklyOpened ? [loadRates({ silent: true })] : []),
    ]);
    setRefreshing(false);
  }, [load, loadSettings, loadEntries, loadRates, weeklyOpened]);

  /** The summary's own retry: everything it is made of, both failure channels. */
  const retryWeekly = useCallback(() => {
    loadEntries();
    loadRates();
  }, [loadEntries, loadRates]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const visible = useMemo(() => filterTrackers(trackers, filter), [trackers, filter]);

  // One interval for the whole list, stopped when the screen loses focus — and
  // not started at all unless a row on screen is actually counting. Under the
  // "Done" filter every duration is fixed, so a frozen clock is the right one.
  // The Weekly tab counts as "no row on screen": its figures come from time
  // entries, none of which move on their own, so a clock ticking behind it
  // would re-render the whole summary once a second to change nothing.
  const ticking = useMemo(
    () => tab === 'trackers' && visible.some(isRunning),
    [tab, visible],
  );
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
   * Time entries per tracker id, or `null` when the fetch has not landed.
   *
   * Derived rather than stored, now that the entries themselves are kept. The
   * `null` is the same `null` it always was and means the same thing: no map at
   * all, as against a map in which a tracker simply does not appear.
   */
  const entryCounts = useMemo(() => {
    if (entries === null) return null;
    const counts: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.tracker_id) counts[entry.tracker_id] = (counts[entry.tracker_id] ?? 0) + 1;
    }
    return counts;
  }, [entries]);

  /**
   * Time entries created from a tracker, or `null` when the lookup has not
   * landed. A tracker absent from a *loaded* map has zero, which the
   * confirmation words differently from not knowing.
   */
  const entryCountFor = (trackerId: string): number | null =>
    entryCounts ? (entryCounts[trackerId] ?? 0) : null;

  // ── The weekly figures ─────────────────────────────────────────────────────
  //
  // Every number on that tab is `summariseWeeks`' work; this file does no
  // arithmetic on hours or money and must not start.

  // Newest Monday first. Recomputed only when the window size changes, which
  // makes it a stable dependency below.
  const weekStarts = useMemo(() => recentWeekStarts(weekCount), [weekCount]);

  // `trackers` and `projects` are this screen's own state, so a tracker
  // created, edited, stopped or deleted reaches the summary the moment the list
  // updates — with no request at all. That is why none of those handlers
  // refetch anything. Entries are the one input the screen cannot infer, and
  // billing is the one action that writes them.
  const weeks = useMemo(
    () =>
      summariseWeeks({
        sessions: entries ?? [],
        trackers,
        projects,
        clients,
        settings: invoiceSettings,
        weekStarts,
      }),
    [entries, trackers, projects, clients, invoiceSettings, weekStarts],
  );

  const applyTracker = useCallback((updated: Tracker) => {
    // Re-sorted rather than spliced in place: an edited start time moves a row.
    setTrackers((prev) =>
      sortByStartDesc(prev.map((tracker) => (tracker.id === updated.id ? updated : tracker))),
    );
  }, []);

  /**
   * Switch tabs.
   *
   * Every sheet on this screen was opened from a tracker row, and a row that is
   * no longer on screen cannot be the subject of one. Leaving the target set
   * would also spring the sheet back open on the way here, so switching closes
   * them — closing beats hiding.
   */
  const selectTab = useCallback((next: ScreenTab) => {
    setTab(next);
    if (next === 'weekly') {
      setEditing(null);
      setTasksTargetId(null);
      setBillTargetId(null);
      setDeleteTarget(null);
      setRemoveTarget(null);
      setWeeklyOpened(true);
    }
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
    //
    // This is also the only handler on the screen that writes to the `sessions`
    // collection, so it is the only one that has to refetch: the weekly summary
    // is stale the instant a bill lands, and its hours are the one input this
    // screen cannot derive from state it already holds. Everything else here
    // moves trackers only, which the summary already follows for free.
    loadEntries();
    return created;
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const header = (
    <View className="border-b border-slate-800 px-4 pb-3 pt-1">
      <Text className="text-xl font-bold text-slate-100">Trackers</Text>

      {/*
        The tab strip. Deliberately not a row of `Chip`s, which is what the
        tracker filters below are: two rows of identical pills doing different
        jobs read as one control. A tab is where you are; a filter narrows what
        is already there.
      */}
      <View className="mt-2 flex-row gap-1">
        {SCREEN_TABS.map(([value, label]) => {
          const active = value === tab;
          return (
            <Pressable
              key={value}
              onPress={() => selectTab(value)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              hitSlop={4}
              className={`rounded-lg px-3 py-1.5 ${
                active ? 'bg-slate-800' : 'active:bg-slate-800/50'
              }`}
              testID={`trackers-tab-${value}`}
            >
              <Text
                className={`text-xs font-medium ${active ? 'text-slate-100' : 'text-slate-400'}`}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/*
        Everything below the strip belongs to one tab or the other.
        The filters go because they narrow a list that is not on screen — and
        the hours line goes with them for a sharper reason: it is wall-clock
        tracker time under the current filter, while every figure on the Weekly
        tab is time-entry time. Stacking the two invites the reader to compare
        numbers that were never measuring the same thing.
      */}
      {tab === 'weekly' ? (
        <Text className="mt-2 text-xs leading-relaxed text-slate-500">
          What each week of work came to, counted from your time entries.
        </Text>
      ) : (
        <>
          <Text className="mt-2 text-xs leading-relaxed text-slate-500">
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
        </>
      )}
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

      <Screen
        header={header}
        // No new-tracker bar on the Weekly tab: it acts on a list that is not
        // on screen, and the summary is a thing you read, not a thing you add
        // to. Pull-to-refresh stays on both tabs.
        footer={tab === 'trackers' ? footer : null}
        refreshing={refreshing}
        onRefresh={handleRefresh}
      >
        {tab === 'weekly' ? (
          <>
            {/*
              The non-fatal channel, kept here rather than passed down: the
              view's own `error` replaces the summary with a retry, and a rate
              that merely fell back a level must not blank figures that are
              still true. `Screen`'s body is a `gap-4` column, so this sits
              above the summary without a wrapper.
            */}
            {rateNote ? (
              <View className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3">
                <Text className="text-xs leading-relaxed text-amber-300">{rateNote}</Text>
              </View>
            ) : null}

            {/* Plain content — `Screen` above is the only scroller. */}
            <WeeklySummaryView
              weeks={weeks}
              weekCount={weekCount}
              onChangeWeekCount={setWeekCount}
              loading={entriesLoading || ratesLoading}
              error={entriesError}
              onRetry={retryWeekly}
            />
          </>
        ) : loading ? (
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
