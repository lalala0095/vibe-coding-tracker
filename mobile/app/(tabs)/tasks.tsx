// Tasks (MobileAppPlan §6.3).
//
// The data-owning screen: one fetch, filters and the derived row list, the
// optimistic status cycle, and every write. Presentation lives in
// `src/screens/tasks/`.
//
// ── One modal at a time ──────────────────────────────────────────────────────
//
// Opening a task, editing it, adding a sub-task to it and deleting it are four
// panes of one flow, so they are one `view` state rather than four booleans —
// which is also what keeps a second `Modal` from being presented over a first.
// The state holds an **id**, never the task object: a status cycle or a save
// replaces the row, and a pane holding the old object would go stale.
//
// ── Clearing conventions on the wire ─────────────────────────────────────────
//
// `TaskForm` emits plain values, `null` meaning "cleared". The mapping onto the
// API happens here and differs by verb:
//
//   PUT /tasks/{id}   `parent_task_id` and `due_date` are cleared with the
//                     literal string `"null"` (`back/routers/tasks.py:400,410`
//                     lower-cases and compares exactly that). A JSON null is
//                     not it, an empty string is not it, and omitting the key
//                     leaves the stored value untouched — which is why every
//                     field is sent on every save.
//   POST /tasks       there is nothing to clear on a document that does not
//                     exist yet, so an unset field is simply omitted.
//
// Out of scope, deliberately: attachments (`createTask`/`updateTask` in
// `src/api.ts` take no files) and paste-bulk — that one belongs to the tracker's
// Add-tasks flow, where the paste parser already lives.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';

import {
  apiErrorMessage,
  createTask,
  deleteTask,
  getClients,
  getProjects,
  getTasks,
  updateTask,
} from '@/api';
import { Button, EmptyState, ErrorNote, LoadingBlock, Screen } from '@/components';
import { todaySgt } from '@/lib/sgt';
import DeleteTaskSheet from '@/screens/tasks/DeleteTaskSheet';
import QuickAddSheet from '@/screens/tasks/QuickAddSheet';
import TaskDetailSheet from '@/screens/tasks/TaskDetailSheet';
import TaskFilters from '@/screens/tasks/TaskFilters';
import TaskForm, { type TaskFormValues } from '@/screens/tasks/TaskForm';
import TaskRow from '@/screens/tasks/TaskRow';
import { buildTaskRows, type StatusFilter, type TaskRowItem } from '@/screens/tasks/rows';
import { NEXT_STATUS } from '@/screens/tasks/taskMeta';
import { theme } from '@/theme';
import type { Client, CreateTaskPayload, Project, Task, TaskStatus } from '@/types';

/** The one open pane, if any. Ids, not objects — see the header. */
type TaskView =
  | { kind: 'quick-add' }
  | { kind: 'detail'; taskId: string }
  | { kind: 'edit'; taskId: string }
  | { kind: 'sub-task'; parentId: string }
  | { kind: 'delete'; taskId: string };

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

  const [view, setView] = useState<TaskView | null>(null);

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

  /**
   * Relax whichever filters would hide a task that was just written.
   *
   * Saving something and watching the list not change reads as a failed save,
   * so a write that lands outside the current narrowing widens it rather than
   * leaving the screen looking untouched.
   */
  const revealTask = useCallback((task: Task) => {
    setStatus((current) => (current === 'all' || current === task.status ? current : 'all'));
    setClientId((current) => (current === null || current === task.client_id ? current : null));
    setProjectId((current) => (current === null || current === task.project_id ? current : null));
  }, []);

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

  // ── Writes ──────────────────────────────────────────────────────────────────

  const handleQuickCreate = useCallback(
    async (payload: CreateTaskPayload) => {
      const created = await createTask(payload);
      setTasks((current) => [created, ...current]);
      revealTask(created);
    },
    [revealTask],
  );

  /** A sub-task: the parent and its project come pre-filled, both editable. */
  const handleCreateSubTask = useCallback(
    async (values: TaskFormValues) => {
      const created = await createTask({
        title: values.title,
        // Optional fields are omitted rather than cleared: nothing exists yet
        // to clear, and `POST /tasks` reads a falsy value as "not set".
        ...(values.description ? { description: values.description } : {}),
        project_id: values.project_id,
        ...(values.parent_task_id ? { parent_task_id: values.parent_task_id } : {}),
        status: values.status,
        priority: values.priority,
        ...(values.due_date ? { due_date: values.due_date } : {}),
      });
      setTasks((current) => [created, ...current]);
      revealTask(created);
      setView(null);
    },
    [revealTask],
  );

  const handleUpdate = useCallback(
    async (task: Task, values: TaskFormValues) => {
      const updated = await updateTask(task.id, {
        title: values.title,
        // `description` is a plain string server-side, not a nullable field:
        // "" is its cleared state, and no `"null"` is involved.
        description: values.description,
        project_id: values.project_id,
        // The clearing convention. `"null"` is the literal string the server
        // compares against; a JSON null would arrive as the four characters
        // "None" through multipart, and omitting the key would leave the
        // existing parent in place.
        parent_task_id: values.parent_task_id ?? 'null',
        status: values.status,
        priority: values.priority,
        due_date: values.due_date ?? 'null',
      });
      setTasks((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      revealTask(updated);
      setView(null);
    },
    [revealTask],
  );

  /**
   * No cascade, by design server-side. Sub-tasks and time entries survive this;
   * `DeleteTaskSheet` is where that is spelled out before it happens.
   */
  const handleDelete = useCallback(async (task: Task) => {
    await deleteTask(task.id);
    setTasks((current) => current.filter((row) => row.id !== task.id));
    setView(null);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  const today = todaySgt();
  // With a project pinned, every row would repeat the same breadcrumb.
  const showBreadcrumb = projectId === null;

  const openTask = useCallback((task: Task) => {
    setView({ kind: 'detail', taskId: task.id });
  }, []);

  // Re-read from the list on every render: the pane must follow a status cycle
  // or a save, and must close by itself if its task is deleted underneath it.
  const viewedTask = useMemo<Task | null>(() => {
    if (!view || view.kind === 'quick-add') return null;
    const id = view.kind === 'sub-task' ? view.parentId : view.taskId;
    return tasks.find((task) => task.id === id) ?? null;
  }, [view, tasks]);

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
      <Button label="New task" onPress={() => setView({ kind: 'quick-add' })} testID="tasks-new" />
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
      onAction={() => setView({ kind: 'quick-add' })}
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
              onOpen={openTask}
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
        open={view?.kind === 'quick-add'}
        projects={projects}
        defaultProjectId={projectId}
        onClose={() => setView(null)}
        onCreate={handleQuickCreate}
      />

      {view?.kind === 'detail' ? (
        <TaskDetailSheet
          task={viewedTask}
          tasks={tasks}
          today={today}
          onCycleStatus={handleCycleStatus}
          onEdit={(task) => setView({ kind: 'edit', taskId: task.id })}
          onAddSubTask={(task) => setView({ kind: 'sub-task', parentId: task.id })}
          onDelete={(task) => setView({ kind: 'delete', taskId: task.id })}
          onClose={() => setView(null)}
        />
      ) : null}

      {view?.kind === 'edit' && viewedTask ? (
        <TaskForm
          task={viewedTask}
          parent={null}
          tasks={tasks}
          projects={projects}
          onSubmit={(values) => handleUpdate(viewedTask, values)}
          onCancel={() => setView(null)}
        />
      ) : null}

      {view?.kind === 'sub-task' && viewedTask ? (
        <TaskForm
          task={null}
          parent={viewedTask}
          tasks={tasks}
          projects={projects}
          onSubmit={handleCreateSubTask}
          onCancel={() => setView(null)}
        />
      ) : null}

      {view?.kind === 'delete' ? (
        <DeleteTaskSheet
          task={viewedTask}
          tasks={tasks}
          onConfirm={handleDelete}
          onClose={() => setView(null)}
        />
      ) : null}
    </Screen>
  );
}
