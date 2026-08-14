// Now — the screen the app exists for.
//
// It owns the data (one `useCallback` + `useEffect` fetch pair with
// `loading`/`error` state, the way every page in `front/` is written) and hands
// it to the four pieces under `src/screens/now/`. Nothing below this file
// fetches on its own except the two lookups a sheet needs while open: the task
// list to pick from, and the entries already billed from this tracker.
//
// ── Two rules this file is where they are kept ────────────────────────────────
//
// 1. **No `.toISOString()`.** Stopping writes `nowSgt()`. The web's Stop button
//    (`front/src/pages/TrackersPage.tsx:1264`) writes UTC with a `Z`, which
//    dates a tracker stopped between midnight and 08:00 SGT a day early. That
//    defect stops at the edge of this file.
// 2. **Time Entries, never "Sessions".** `billTracker` writes to the `sessions`
//    collection, which is called Time Entries everywhere a user can see it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import {
  addTasksToTracker,
  apiErrorMessage,
  billTracker,
  createTasksBulk,
  createTracker,
  getProjects,
  getTrackerSettings,
  getTrackers,
  removeTaskFromTracker,
  updateTracker,
} from '@/api';
import { Button, EmptyState, ErrorNote, LoadingBlock, Screen } from '@/components';
import { formatSgtDate, nowSgt } from '@/lib/sgt';
import type {
  BillTrackerPayload,
  CreateTrackerPayload,
  Project,
  Session,
  Tracker,
  TrackerSettings,
} from '@/types';

import ActiveTrackerCard from '@/screens/now/ActiveTrackerCard';
import AddTasksSheet from '@/screens/now/AddTasksSheet';
import BillTrackerSheet from '@/screens/now/BillTrackerSheet';
import StartTrackerSheet from '@/screens/now/StartTrackerSheet';
import { mostRecentlyStarted } from '@/screens/now/trackerTime';

export default function NowScreen() {
  const [actives, setActives] = useState<Tracker[]>([]);
  // The tracker stopped during this visit. `active_only=true` will not return it
  // again, but stop → create time entries is one motion, so the card stays on
  // screen until the next refresh rather than vanishing at the moment it becomes
  // billable.
  const [justStopped, setJustStopped] = useState<Tracker | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<TrackerSettings | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [startOpen, setStartOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setError('');
    try {
      const [activeTrackers, projectList] = await Promise.all([
        getTrackers({ active_only: true }),
        getProjects(),
      ]);
      setActives(activeTrackers);
      setProjects(projectList);
      setJustStopped(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load what is running.'));
    } finally {
      setLoading(false);
    }
  }, []);

  // Best-effort and deliberately separate: the auto-name template is a
  // convenience, and a settings hiccup must not stand between the owner and a
  // running timer. A failure costs the pre-filled title and nothing else.
  const fetchSettings = useCallback(async () => {
    try {
      setSettings(await getTrackerSettings());
    } catch {
      setSettings(null);
    }
  }, []);

  useEffect(() => {
    fetchData();
    fetchSettings();
  }, [fetchData, fetchSettings]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchData(), fetchSettings()]);
    setRefreshing(false);
  }, [fetchData, fetchSettings]);

  const active = useMemo(() => mostRecentlyStarted(actives), [actives]);
  // What the card shows: whatever is running, or failing that whatever was just
  // stopped here.
  const focused = active ?? justStopped;

  const applyTracker = useCallback((updated: Tracker) => {
    setActives((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setJustStopped((prev) => (prev && prev.id === updated.id ? updated : prev));
  }, []);

  async function handleStart(payload: CreateTrackerPayload) {
    const created = await createTracker(payload);
    setActives((prev) => [created, ...prev]);
    setJustStopped(null);
  }

  async function handleStop() {
    if (!focused) return;
    // `nowSgt()`, never `new Date().toISOString()` — see the header.
    const updated = await updateTracker(focused.id, { end_time: nowSgt() });
    setActives((prev) => prev.filter((t) => t.id !== updated.id));
    setJustStopped(updated);
  }

  async function handleAddTasks(taskIds: string[]) {
    if (!focused) return;
    applyTracker(await addTasksToTracker(focused.id, taskIds));
  }

  // Pasted titles become real tasks first, then get attached. Both calls have to
  // land, so nothing is caught here — the sheet stays open and says what failed.
  async function handleCreateTasks(projectId: string, titles: string[]) {
    if (!focused) return;
    const created = await createTasksBulk({ project_id: projectId, titles });
    applyTracker(await addTasksToTracker(focused.id, created.map((task) => task.id)));
  }

  async function handleRemoveTask(taskId: string) {
    if (!focused) return;
    applyTracker(await removeTaskFromTracker(focused.id, taskId));
  }

  async function handleBill(payload: BillTrackerPayload): Promise<Session[]> {
    if (!focused) return [];
    return billTracker(focused.id, payload);
  }

  const noTasks = focused !== null && focused.tasks.length === 0;

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={handleRefresh}
      header={
        <View className="gap-0.5 px-4 pb-2 pt-2">
          <Text className="text-xs uppercase tracking-wider text-slate-500">
            {formatSgtDate(nowSgt())}
          </Text>
          <Text className="text-2xl font-semibold text-slate-100">Now</Text>
        </View>
      }
      footer={
        focused ? (
          <View className="gap-2 border-t border-slate-800 px-4 pb-2 pt-3">
            {noTasks ? (
              <Text className="text-xs text-slate-500">
                Add a task to this block before its time can become entries.
              </Text>
            ) : null}
            <Button
              label="Create time entries"
              size="lg"
              // Submit guard: the server has nothing to bill without a task.
              disabled={noTasks}
              onPress={() => setBillOpen(true)}
            />
          </View>
        ) : undefined
      }
    >
      {error ? <ErrorNote message={error} onRetry={fetchData} /> : null}

      {loading ? (
        <LoadingBlock label="Checking what is running…" />
      ) : focused ? (
        <>
          <ActiveTrackerCard
            tracker={focused}
            otherActiveCount={Math.max(0, actives.length - 1)}
            onStop={handleStop}
            onAddTasks={() => setAddOpen(true)}
            onRemoveTask={handleRemoveTask}
          />

          {focused.end_time ? (
            <Button
              label="Start another tracker"
              variant="secondary"
              onPress={() => setStartOpen(true)}
            />
          ) : null}
        </>
      ) : error ? null : (
        <View className="flex-1 justify-center gap-6">
          <EmptyState
            title="Nothing is running"
            subtitle="Start a tracker and the clock begins. Tasks go in as you work; time entries come out at the end."
          />
          <Button label="Start tracker" size="lg" onPress={() => setStartOpen(true)} />
        </View>
      )}

      {/* Each sheet is mounted only while open, so every opening is a fresh one —
          which is what lets the start form render its auto-name for the moment
          you opened it and the billing form snapshot the span at that instant. */}
      {startOpen ? (
        <StartTrackerSheet
          open
          settings={settings}
          onClose={() => setStartOpen(false)}
          onStart={handleStart}
        />
      ) : null}

      {addOpen && focused ? (
        <AddTasksSheet
          open
          tracker={focused}
          projects={projects}
          onClose={() => setAddOpen(false)}
          onAdd={handleAddTasks}
          onCreate={handleCreateTasks}
        />
      ) : null}

      {billOpen && focused ? (
        <BillTrackerSheet
          open
          tracker={focused}
          onClose={() => setBillOpen(false)}
          onBill={handleBill}
        />
      ) : null}
    </Screen>
  );
}
