// Tasks (MobileAppPlan §6.3).
//
// The data-owning screen: one fetch, filters and the derived row list, the
// optimistic status cycle, and quick-add. Presentation lives in
// `src/screens/tasks/`.
//
// Out of scope in v1, deliberately: attachments (`createTask` takes no files),
// delete (`src/api.ts` exposes none), sub-task creation and re-parenting, and
// paste-bulk — that one belongs to the tracker's Add-tasks flow, where the
// paste parser already lives.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';

import { apiErrorMessage, createTask, getClients, getProjects, getTasks, updateTask } from '@/api';
import { Button, EmptyState, ErrorNote, LoadingBlock, Screen } from '@/components';
import { todaySgt } from '@/lib/sgt';
import QuickAddSheet from '@/screens/tasks/QuickAddSheet';
import TaskFilters from '@/screens/tasks/TaskFilters';
import TaskRow from '@/screens/tasks/TaskRow';
import { buildTaskRows, type StatusFilter, type TaskRowItem } from '@/screens/tasks/rows';
import { NEXT_STATUS } from '@/screens/tasks/taskMeta';
import { theme } from '@/theme';
import type { Client, CreateTaskPayload, Project, Task, TaskStatus } from '@/types';

export default function TasksScreen() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  // A failed status cycle, reported separately: the list is still good, and
  // replacing it with a full-screen error over one row would be a lie.
  const [actionError, setActionError] = useState('');

  const [clientId, setClientId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');

  const [quickAddOpen, setQuickAddOpen] = useState(false);

  // ── Data ────────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'refresh') setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      // `GET /tasks` is unpaginated and returns sub-tasks too, so one call is
      // the whole tree — no round trip per expanded parent as on the web.
      const [tasksData, projectsData, clientsData] = await Promise.all([
        getTasks(),
        getProjects(),
        getClients(),
      ]);
      setTasks(tasksData);
      setProjects(projectsData);
      setClients(clientsData);
    } catch (e: unknown) {
      setError(apiErrorMessage(e, 'Could not load tasks.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchData('initial');
  }, [fetchData]);

  const handleRefresh = useCallback(() => {
    void fetchData('refresh');
  }, [fetchData]);

  // ── Filters ─────────────────────────────────────────────────────────────────

  const handleClientChange = useCallback(
    (value: string | null) => {
      setClientId(value);
      // A project belonging to a different client would filter everything away
      // with no visible reason.
      setProjectId((current) => {
        if (!current || !value) return current;
        const project = projects.find((candidate) => candidate.id === current);
        return project && project.client_id === value ? current : null;
      });
    },
    [projects],
  );

  const handleProjectChange = useCallback(
    (value: string | null) => {
      setProjectId(value);
      // Choosing a project implies its client; keeping a contradictory client
      // selected is the other way to end up with an unexplained empty list.
      if (!value) return;
      const project = projects.find((candidate) => candidate.id === value);
      if (project) setClientId(project.client_id);
    },
    [projects],
  );

  const clearFilters = useCallback(() => {
    setClientId(null);
    setProjectId(null);
    setStatus('all');
  }, []);

  const hasFilters = clientId !== null || projectId !== null || status !== 'all';

  const rows = useMemo<TaskRowItem[]>(
    () => buildTaskRows(tasks, { clientId, projectId, status }),
    [tasks, clientId, projectId, status],
  );

  // ── Status cycle ────────────────────────────────────────────────────────────

  /**
   * `todo → in_progress → done → todo`, applied to the row first and to the
   * server second.
   *
   * A phone tap that waits on a round trip reads as a broken control, so the
   * chip changes immediately. Both the success and the failure path write back
   * **only if the row still holds the value this tap wrote** — a second tap
   * during the flight has already moved it on, and neither a late server row
   * nor a rollback may drag it back.
   */
  const cycleStatus = useCallback(async (task: Task) => {
    const previous = task.status;
    const next = NEXT_STATUS[previous];

    const replaceIfUnchanged = (expected: TaskStatus, apply: (current: Task) => Task) =>
      setTasks((current) =>
        current.map((row) => (row.id === task.id && row.status === expected ? apply(row) : row)),
      );

    setActionError('');
    setTasks((current) =>
      current.map((row) => (row.id === task.id ? { ...row, status: next } : row)),
    );

    try {
      const updated = await updateTask(task.id, { status: next });
      // The server row carries the refreshed `datetime_updated` and any
      // denormalised names it rewrote.
      replaceIfUnchanged(next, () => updated);
    } catch (e: unknown) {
      replaceIfUnchanged(next, (row) => ({ ...row, status: previous }));
      setActionError(apiErrorMessage(e, 'Could not update that task. It has been put back.'));
    }
  }, []);

  const handleCycleStatus = useCallback(
    (task: Task) => {
      void cycleStatus(task);
    },
    [cycleStatus],
  );

  // ── Quick add ───────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async (payload: CreateTaskPayload) => {
    const created = await createTask(payload);
    setTasks((current) => [created, ...current]);
    // Filters that would hide what was just created get relaxed rather than
    // leaving the screen looking like nothing happened.
    setStatus((current) => (current === 'all' || current === created.status ? current : 'all'));
    setClientId((current) => (current === null || current === created.client_id ? current : null));
    setProjectId((current) =>
      current === null || current === created.project_id ? current : null,
    );
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  const today = todaySgt();
  // With a project pinned, every row would repeat the same breadcrumb.
  const showBreadcrumb = projectId === null;

  const header = (
    <View className="gap-3 border-b border-slate-800 px-4 pb-3 pt-2">
      <View className="flex-row items-end justify-between">
        <Text className="text-xl font-semibold text-slate-100">Tasks</Text>
        <Text className="text-xs text-slate-500">
          {rows.length} {rows.length === 1 ? 'task' : 'tasks'}
        </Text>
      </View>
      <TaskFilters
        clients={clients}
        projects={projects}
        clientId={clientId}
        projectId={projectId}
        status={status}
        onClientChange={handleClientChange}
        onProjectChange={handleProjectChange}
        onStatusChange={setStatus}
      />
    </View>
  );

  const footer = (
    <View className="border-t border-slate-800 px-4 py-3">
      <Button label="New task" onPress={() => setQuickAddOpen(true)} testID="tasks-new" />
    </View>
  );

  const empty = hasFilters ? (
    <EmptyState
      title="Nothing matches these filters"
      subtitle="There are tasks here, just not with this client, project or status."
      actionLabel="Clear filters"
      onAction={clearFilters}
    />
  ) : (
    <EmptyState
      title="No tasks yet"
      subtitle="Capture one now and sort out the details later."
      actionLabel="New task"
      onAction={() => setQuickAddOpen(true)}
    />
  );

  return (
    // `edges` omits the bottom: the tab bar sits below this screen and already
    // carries that inset.
    <Screen scroll={false} className="flex-1" edges={['top']} header={header} footer={footer}>
      {actionError ? (
        <View className="px-4 pt-3">
          <ErrorNote
            message={actionError}
            onRetry={() => setActionError('')}
            retryLabel="Dismiss"
          />
        </View>
      ) : null}

      {loading ? (
        <LoadingBlock label="Loading tasks…" />
      ) : error ? (
        <View className="px-4 pt-4">
          <ErrorNote message={error} onRetry={() => void fetchData('initial')} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.task.id}
          renderItem={({ item }) => (
            <TaskRow
              task={item.task}
              depth={item.depth}
              detached={item.detached}
              showBreadcrumb={showBreadcrumb}
              today={today}
              onCycleStatus={handleCycleStatus}
            />
          )}
          contentContainerStyle={{ flexGrow: 1, padding: 16, gap: 10 }}
          ListEmptyComponent={empty}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.refreshTint}
              colors={[theme.refreshTint]}
              progressBackgroundColor={theme.surface}
            />
          }
          testID="tasks-list"
        />
      )}

      <QuickAddSheet
        open={quickAddOpen}
        projects={projects}
        defaultProjectId={projectId}
        onClose={() => setQuickAddOpen(false)}
        onCreate={handleCreate}
      />
    </Screen>
  );
}
