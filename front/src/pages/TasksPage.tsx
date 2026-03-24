import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { getTasks, getTask, getClients, getProjects, getModels, createTask, updateTask } from '../api';
import type { Task, Client, Project, Model, Goal, TaskStatus, TaskPriority, CreateTaskPayload } from '../types';
import TaskPanel from '../components/TaskPanel';
import GoalPanel from '../components/GoalPanel';
import TaskForm from '../components/TaskForm';

// ── Helpers ──────────────────────────────────────────────────────────────────

const PRIORITY_DOT: Record<TaskPriority, string> = {
  low: 'bg-slate-400',
  medium: 'bg-blue-400',
  high: 'bg-orange-400',
  urgent: 'bg-red-400',
};


const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  const d = new Date(Number(year), Number(month) - 1, Number(day));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function dueDateColor(dateStr: string | null): string {
  if (!dateStr) return 'text-slate-500';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [year, month, day] = dateStr.split('-');
  const due = new Date(Number(year), Number(month) - 1, Number(day));
  if (due < today) return 'text-red-400';
  if (due.getTime() === today.getTime()) return 'text-orange-400';
  return 'text-slate-500';
}

// ── Types ─────────────────────────────────────────────────────────────────────

type FilterStatus = 'all' | TaskStatus;
type FilterPriority = 'all' | TaskPriority;

type ModalState = { kind: 'none' } | { kind: 'create' };

// ── Task Row ─────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: Task;
  depth?: number;
  subtaskCount?: number;
  showBreadcrumb: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onStatusCycle: (task: Task) => void;
  onOpen: (task: Task) => void;
  togglingId: string | null;
}

function TaskRow({
  task,
  depth = 0,
  subtaskCount = 0,
  showBreadcrumb,
  expanded,
  onToggleExpand,
  onStatusCycle,
  onOpen,
  togglingId,
}: TaskRowProps) {
  const isDone = task.status === 'done';

  return (
    <div
      className="flex items-center gap-3 py-2.5 group hover:bg-slate-800/50 transition-colors border-b border-slate-800/50"
      style={{ paddingLeft: `${16 + depth * 20}px`, paddingRight: '16px' }}
    >
      {/* Expand/collapse chevron */}
      {subtaskCount > 0 ? (
        <button
          onClick={onToggleExpand}
          className="w-4 h-4 shrink-0 text-slate-500 hover:text-slate-300 transition-colors"
          title={expanded ? 'Collapse subtasks' : 'Expand subtasks'}
        >
          <svg
            className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      ) : (
        <div className="w-4 shrink-0" />
      )}

      {/* Status checkbox */}
      <button
        onClick={() => onStatusCycle(task)}
        disabled={togglingId === task.id}
        className={`w-4 h-4 rounded shrink-0 border-2 flex items-center justify-center transition-colors
          ${isDone
            ? 'bg-green-500 border-green-500'
            : task.status === 'in_progress'
            ? 'border-blue-400 bg-blue-400/10'
            : 'border-slate-600 bg-transparent hover:border-slate-400'
          } disabled:opacity-50`}
        title={`Status: ${STATUS_LABEL[task.status]} — click to cycle`}
      >
        {isDone && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        )}
        {task.status === 'in_progress' && (
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
        )}
      </button>

      {/* Priority dot */}
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_DOT[task.priority]}`}
        title={`Priority: ${task.priority}`}
      />

      {/* Title + breadcrumb */}
      <button
        onClick={() => { onOpen(task); if (onToggleExpand) onToggleExpand(); }}
        className="flex-1 min-w-0 text-left"
      >
        <span className={`text-sm font-medium leading-snug block truncate ${
          isDone ? 'line-through text-slate-500' : 'text-slate-100 group-hover:text-white'
        }`}>
          {task.title}
        </span>
        {showBreadcrumb && (
          <span className="text-xs text-slate-500 truncate block">
            {task.client_name} / {task.project_name}
          </span>
        )}
      </button>

      {/* Subtask count badge */}
      {subtaskCount > 0 && (
        <span className="shrink-0 text-xs text-slate-500 bg-slate-800 border border-slate-700 rounded-full px-1.5 py-0.5 font-medium">
          {subtaskCount}
        </span>
      )}

      {/* Attachment count */}
      {task.attachments && task.attachments.length > 0 && (
        <span className="shrink-0 flex items-center gap-1 text-xs text-slate-500">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
          </svg>
          {task.attachments.length}
        </span>
      )}

      {/* Due date */}
      {task.due_date && (
        <span className={`shrink-0 text-xs font-medium ${dueDateColor(task.due_date)}`}>
          {formatDate(task.due_date)}
        </span>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TasksPage() {
  const { user, logout } = useAuth();
  const location = useLocation();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // Filters
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [filterPriority, setFilterPriority] = useState<FilterPriority>('all');

  // Sort
  const [sortField, setSortField] = useState<'title' | 'due_date'>('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Expanded parent tasks (subtask visibility)
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  // Subtask counts & data keyed by parent task id
  const [subtaskCounts, setSubtaskCounts] = useState<Record<string, number>>({});
  const [subtasksMap, setSubtasksMap] = useState<Record<string, Task[]>>({});

  // Create modal + selected task for side panel
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);

  // Status cycling
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Refreshing indicator (separate from initial load)
  const [refreshing, setRefreshing] = useState(false);

  // Ref so refreshAll can always see the latest expandedTasks without stale closure
  const expandedTasksRef = useRef<Set<string>>(expandedTasks);
  useEffect(() => { expandedTasksRef.current = expandedTasks; }, [expandedTasks]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [tasksData, clientsData, projectsData, modelsData] = await Promise.all([
        getTasks(),
        getClients(),
        getProjects(),
        getModels(),
      ]);
      // Only top-level tasks in the main list
      const topLevel = tasksData.filter((t) => !t.parent_task_id);
      topLevel.sort(
        (a, b) => new Date(b.datetime_inserted).getTime() - new Date(a.datetime_inserted).getTime()
      );
      setTasks(topLevel);
      setClients(clientsData);
      setProjects(projectsData);
      setModels(modelsData);

      // Build subtask count map from all tasks
      const counts: Record<string, number> = {};
      tasksData.forEach((t) => {
        if (t.parent_task_id) {
          counts[t.parent_task_id] = (counts[t.parent_task_id] ?? 0) + 1;
        }
      });
      setSubtaskCounts(counts);
    } catch {
      setError('Failed to load data. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Full refresh: re-fetches everything + re-loads any currently expanded subtask branches
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const [tasksData, clientsData, projectsData, modelsData] = await Promise.all([
        getTasks(),
        getClients(),
        getProjects(),
        getModels(),
      ]);
      const topLevel = tasksData.filter((t) => !t.parent_task_id);
      topLevel.sort(
        (a, b) => new Date(b.datetime_inserted).getTime() - new Date(a.datetime_inserted).getTime()
      );
      setTasks(topLevel);
      setClients(clientsData);
      setProjects(projectsData);
      setModels(modelsData);

      const counts: Record<string, number> = {};
      tasksData.forEach((t) => {
        if (t.parent_task_id) {
          counts[t.parent_task_id] = (counts[t.parent_task_id] ?? 0) + 1;
        }
      });
      setSubtaskCounts(counts);

      // Re-fetch subtask lists for all currently expanded branches
      const expanded = expandedTasksRef.current;
      if (expanded.size > 0) {
        const entries = await Promise.all(
          Array.from(expanded).map(async (id) => {
            try {
              const subs = await getTasks({ parent_task_id: id });
              return [id, subs] as [string, Task[]];
            } catch {
              return [id, []] as [string, Task[]];
            }
          })
        );
        setSubtasksMap(Object.fromEntries(entries));
      } else {
        setSubtasksMap({});
      }
    } catch {
      setError('Failed to refresh. Check your connection and try again.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-open a task passed via router state (e.g. from TrackersPage)
  useEffect(() => {
    const openTaskId = (location.state as { openTaskId?: string } | null)?.openTaskId;
    if (!openTaskId || loading) return;
    // Try to find it in the already-loaded list first; fall back to a direct fetch
    // (handles sub-tasks that aren't in the top-level list)
    const found = tasks.find((t) => t.id === openTaskId);
    if (found) {
      setSelectedTask(found);
    } else {
      getTask(openTaskId)
        .then((t) => setSelectedTask(t))
        .catch(() => {/* task not found, silently ignore */});
    }
    // Clear the router state so navigating away and back doesn't re-open
    window.history.replaceState({}, '');
  }, [loading, location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expand all clients by default once loaded
  useEffect(() => {
    if (clients.length > 0) {
      setExpandedClients(new Set(clients.map((c) => c.id)));
    }
  }, [clients]);

  // Load subtasks for a task when expanding
  const loadSubtasks = useCallback(async (taskId: string) => {
    if (subtasksMap[taskId]) return; // already loaded
    try {
      const data = await getTasks({ parent_task_id: taskId });
      setSubtasksMap((prev) => ({ ...prev, [taskId]: data }));
    } catch {
      // silently fail
    }
  }, [subtasksMap]);

  const toggleExpandTask = (taskId: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
        loadSubtasks(taskId);
      }
      return next;
    });
  };

  const cycleStatus = async (task: Task) => {
    const next: TaskStatus =
      task.status === 'todo' ? 'in_progress' :
      task.status === 'in_progress' ? 'done' : 'todo';
    setTogglingId(task.id);
    try {
      const updated = await updateTask(task.id, { status: next }, []);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      // Also update in subtasksMap if present
      setSubtasksMap((prev) => {
        const next2 = { ...prev };
        for (const key of Object.keys(next2)) {
          next2[key] = next2[key].map((t) => (t.id === updated.id ? updated : t));
        }
        return next2;
      });
    } catch {
      // silently fail
    } finally {
      setTogglingId(null);
    }
  };

  const handleCreate = async (data: CreateTaskPayload & { files: File[] }) => {
    const { files, ...payload } = data;
    await createTask(payload, files);
    setModal({ kind: 'none' });
    await refreshAll();
  };

  const handleUpdated = (updated: Task) => {
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setSelectedTask(updated);
  };

  const handleDeleted = (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    setSelectedTask(null);
  };

  // Sidebar filter context label
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const contextLabel = selectedProject
    ? `${selectedProject.client_name} / ${selectedProject.name}`
    : 'All Tasks';

  // Group projects by client for sidebar
  const clientProjectGroups = clients.map((c) => ({
    client: c,
    projects: projects.filter((p) => p.client_id === c.id),
  }));

  // Filter + sort tasks
  const filteredTasks = tasks
    .filter((t) => {
      if (selectedProjectId && t.project_id !== selectedProjectId) return false;
      if (filterStatus !== 'all' && t.status !== filterStatus) return false;
      if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (sortField === 'title') {
        cmp = a.title.localeCompare(b.title);
      } else {
        // null due dates sort last regardless of direction
        if (!a.due_date && !b.due_date) cmp = 0;
        else if (!a.due_date) cmp = 1;
        else if (!b.due_date) cmp = -1;
        else cmp = a.due_date.localeCompare(b.due_date);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

  const toggleSort = (field: 'title' | 'due_date') => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950">
      {/* ── Navigation Header ── */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-sm border-b border-slate-800">
        <div className="w-full px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          {/* Left: brand */}
          <div className="flex items-center gap-3">
            <Link
              to="/dashboard"
              className="flex items-center gap-3 hover:opacity-80 transition-opacity"
            >
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
              <span className="text-base font-semibold text-slate-100 hidden sm:block">
                Vibe Coding Tracker
              </span>
            </Link>
          </div>

          {/* Right: nav links + user */}
          <nav className="flex items-center gap-1">
            <Link
              to="/dashboard"
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Sessions
            </Link>
            <Link
              to="/tasks"
              className="px-3 py-1.5 text-sm text-slate-100 bg-slate-800 rounded-lg transition-colors font-medium"
            >
              Tasks
            </Link>
            <Link
              to="/models"
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Models
            </Link>
            <Link
              to="/trackers"
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Trackers
            </Link>
            <Link
              to="/manage"
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Clients &amp; Projects
            </Link>

            {user?.picture ? (
              <img
                src={user.picture}
                alt={user.name ?? 'User'}
                className="w-8 h-8 rounded-full border border-slate-700 ml-1"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs text-slate-300 ml-1">
                {user?.name?.[0] ?? user?.email?.[0] ?? '?'}
              </div>
            )}

            <button
              onClick={logout}
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <div className="w-full flex h-[calc(100vh-4rem)]">
        {/* ── Sidebar ── */}
        <aside
          className={`shrink-0 border-r border-slate-800 bg-slate-950 flex flex-col overflow-y-auto transition-all duration-200
            ${sidebarOpen ? 'w-56' : 'w-12'}`}
        >
          {/* Sidebar toggle */}
          <div className="flex items-center justify-between px-3 py-3 border-b border-slate-800 shrink-0">
            {sidebarOpen && (
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Projects
              </span>
            )}
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className="p-1 text-slate-500 hover:text-slate-300 rounded-lg hover:bg-slate-800 transition-colors ml-auto"
              title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              <svg
                className={`w-4 h-4 transition-transform ${sidebarOpen ? '' : 'rotate-180'}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
          </div>

          {sidebarOpen && (
            <nav className="flex flex-col py-2">
              {/* All Tasks */}
              <button
                onClick={() => setSelectedProjectId(null)}
                className={`flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors
                  ${selectedProjectId === null
                    ? 'text-violet-400 bg-violet-400/10 font-medium'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                  }`}
              >
                <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                </svg>
                All Tasks
              </button>

              {/* Client / Project tree */}
              {clientProjectGroups.map(({ client, projects: cProjects }) => (
                <div key={client.id}>
                  <button
                    onClick={() =>
                      setExpandedClients((prev) => {
                        const next = new Set(prev);
                        if (next.has(client.id)) next.delete(client.id);
                        else next.add(client.id);
                        return next;
                      })
                    }
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-500
                               hover:text-slate-300 hover:bg-slate-800 transition-colors text-left uppercase tracking-wider"
                  >
                    <svg
                      className={`w-3 h-3 shrink-0 transition-transform ${expandedClients.has(client.id) ? 'rotate-90' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                    <span className="truncate">{client.name}</span>
                  </button>

                  {expandedClients.has(client.id) && cProjects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedProjectId(p.id)}
                      className={`w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-sm text-left transition-colors
                        ${selectedProjectId === p.id
                          ? 'text-violet-400 bg-violet-400/10 font-medium'
                          : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                        }`}
                    >
                      <span className="w-1 h-1 rounded-full bg-current shrink-0 opacity-60" />
                      <span className="truncate">{p.name}</span>
                    </button>
                  ))}

                  {expandedClients.has(client.id) && cProjects.length === 0 && (
                    <p className="pl-6 pr-3 py-1.5 text-xs text-slate-600 italic">No projects</p>
                  )}
                </div>
              ))}
            </nav>
          )}
        </aside>

        {/* ── Main content ── */}
        <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Task list header */}
          <div className="shrink-0 border-b border-slate-800 px-6 py-4">
            <div className="flex items-center justify-between gap-4 mb-3">
              <h1 className="text-lg font-semibold text-slate-100">{contextLabel}</h1>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={refreshAll}
                  disabled={refreshing}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium
                             text-slate-300 bg-slate-800 border border-slate-700 rounded-lg
                             hover:bg-slate-700 hover:text-slate-100 transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Refresh tasks"
                >
                  <svg
                    className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                  Refresh
                </button>
                <button
                  onClick={() => setModal({ kind: 'create' })}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white
                             bg-violet-600 rounded-lg hover:bg-violet-500 transition-colors
                             shadow-lg shadow-violet-500/20 focus:outline-none focus:ring-2
                             focus:ring-violet-500 focus:ring-offset-2 focus:ring-offset-slate-950"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  New Task
                </button>
              </div>
            </div>

            {/* Filter pills */}
            <div className="flex flex-wrap gap-2">
              {/* Status filters */}
              <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-0.5">
                {(['all', 'todo', 'in_progress', 'done'] as FilterStatus[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilterStatus(s)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors
                      ${filterStatus === s
                        ? 'bg-slate-700 text-slate-100'
                        : 'text-slate-500 hover:text-slate-300'
                      }`}
                  >
                    {s === 'all' ? 'All Status' :
                     s === 'todo' ? 'Todo' :
                     s === 'in_progress' ? 'In Progress' : 'Done'}
                  </button>
                ))}
              </div>

              {/* Priority filters */}
              <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-0.5">
                {(['all', 'low', 'medium', 'high', 'urgent'] as FilterPriority[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setFilterPriority(p)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1
                      ${filterPriority === p
                        ? 'bg-slate-700 text-slate-100'
                        : 'text-slate-500 hover:text-slate-300'
                      }`}
                  >
                    {p !== 'all' && (
                      <span className={`w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[p as TaskPriority]}`} />
                    )}
                    {p === 'all' ? 'All Priority' :
                     p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Task list body */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <div className="w-10 h-10 border-4 border-violet-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-slate-400 text-sm">Loading tasks…</p>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-xl px-5 py-3">
                  {error}
                </p>
                <button
                  onClick={fetchData}
                  className="text-sm text-violet-400 hover:text-violet-300 underline"
                >
                  Retry
                </button>
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
                <div className="w-14 h-14 rounded-2xl bg-slate-800 flex items-center justify-center mb-1">
                  <svg className="w-7 h-7 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
                  </svg>
                </div>
                <p className="text-slate-300 font-medium">
                  {filterStatus !== 'all' || filterPriority !== 'all'
                    ? 'No tasks match these filters'
                    : 'No tasks yet'}
                </p>
                <p className="text-slate-500 text-sm max-w-xs">
                  {filterStatus !== 'all' || filterPriority !== 'all'
                    ? 'Try adjusting your filters or clearing them.'
                    : projects.length === 0
                    ? 'Create a client and project first, then add your first task.'
                    : 'Add your first task to get started.'}
                </p>
                {filterStatus === 'all' && filterPriority === 'all' && projects.length === 0 ? (
                  <Link
                    to="/manage"
                    className="mt-1 px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-xl
                               hover:bg-violet-500 transition-colors"
                  >
                    Manage Clients &amp; Projects
                  </Link>
                ) : filterStatus === 'all' && filterPriority === 'all' ? (
                  <button
                    onClick={() => setModal({ kind: 'create' })}
                    className="mt-1 px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-xl
                               hover:bg-violet-500 transition-colors"
                  >
                    New Task
                  </button>
                ) : (
                  <button
                    onClick={() => { setFilterStatus('all'); setFilterPriority('all'); }}
                    className="text-sm text-violet-400 hover:text-violet-300 underline"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div>
                {/* Column headers */}
                <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 text-xs font-medium uppercase tracking-wider sticky top-0 bg-slate-950/90 backdrop-blur-sm">
                  <div className="w-4 shrink-0" />
                  <div className="w-4 shrink-0" />
                  <button
                    onClick={() => toggleSort('title')}
                    className={`flex-1 flex items-center gap-1 text-left hover:text-slate-200 transition-colors ${
                      sortField === 'title' ? 'text-slate-200' : 'text-slate-500'
                    }`}
                  >
                    Task
                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      {sortField === 'title' && sortDir === 'asc' ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                      ) : sortField === 'title' && sortDir === 'desc' ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 15l3.75-3.75L15.75 15M8.25 9l3.75 3.75L15.75 9" />
                      )}
                    </svg>
                  </button>
                  <button
                    onClick={() => toggleSort('due_date')}
                    className={`shrink-0 w-20 flex items-center justify-end gap-1 hover:text-slate-200 transition-colors ${
                      sortField === 'due_date' ? 'text-slate-200' : 'text-slate-500'
                    }`}
                  >
                    Due
                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      {sortField === 'due_date' && sortDir === 'asc' ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                      ) : sortField === 'due_date' && sortDir === 'desc' ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 15l3.75-3.75L15.75 15M8.25 9l3.75 3.75L15.75 9" />
                      )}
                    </svg>
                  </button>
                </div>

                {(() => {
                  const renderBranch = (task: Task, depth: number): React.ReactNode => {
                    const count = subtaskCounts[task.id] ?? 0;
                    const isExpanded = expandedTasks.has(task.id);
                    return (
                      <div key={task.id}>
                        <TaskRow
                          task={task}
                          depth={depth}
                          subtaskCount={count}
                          showBreadcrumb={depth === 0 && selectedProjectId === null}
                          expanded={isExpanded}
                          onToggleExpand={() => toggleExpandTask(task.id)}
                          onStatusCycle={cycleStatus}
                          onOpen={(t) => { setSelectedTask(t); setSelectedGoal(null); }}
                          togglingId={togglingId}
                        />
                        {isExpanded && (
                          <>
                            {!subtasksMap[task.id] ? (
                              <div
                                className="py-2 text-xs text-slate-500 flex items-center gap-2"
                                style={{ paddingLeft: `${16 + (depth + 1) * 20}px` }}
                              >
                                <div className="w-3 h-3 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                                Loading subtasks…
                              </div>
                            ) : subtasksMap[task.id].length === 0 ? (
                              <div
                                className="py-2 text-xs text-slate-600 italic"
                                style={{ paddingLeft: `${16 + (depth + 1) * 20}px` }}
                              >
                                No subtasks.
                              </div>
                            ) : (
                              subtasksMap[task.id].map((sub) => renderBranch(sub, depth + 1))
                            )}
                          </>
                        )}
                      </div>
                    );
                  };
                  return filteredTasks.map((task) => renderBranch(task, 0));
                })()}
              </div>
            )}
          </div>
        </main>

        {/* ── Task detail side panel ── */}
        {selectedTask && !selectedGoal && (
          <TaskPanel
            task={selectedTask}
            projects={projects}
            models={models}
            onClose={() => setSelectedTask(null)}
            onUpdated={handleUpdated}
            onDeleted={handleDeleted}
            onSessionOpen={(goal) => setSelectedGoal(goal)}
          />
        )}

        {/* ── Session detail side panel ── */}
        {selectedGoal && (
          <GoalPanel
            goal={selectedGoal}
            models={models}
            onClose={() => setSelectedGoal(null)}
            onUpdated={(updated) => setSelectedGoal(updated)}
            onDeleted={() => setSelectedGoal(null)}
          />
        )}
      </div>

      {/* ── Create Modal ── */}
      {modal.kind === 'create' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="relative w-full max-w-2xl max-h-[90vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
              <h2 className="text-base font-semibold text-slate-100">New Task</h2>
              <button
                onClick={() => setModal({ kind: 'none' })}
                className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {projects.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-slate-300 font-medium mb-2">No projects found</p>
                  <p className="text-slate-500 text-sm mb-4">
                    You need at least one client and project before creating tasks.
                  </p>
                  <Link
                    to="/manage"
                    onClick={() => setModal({ kind: 'none' })}
                    className="inline-flex px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-xl
                               hover:bg-violet-500 transition-colors"
                  >
                    Manage Clients &amp; Projects
                  </Link>
                </div>
              ) : (
                <TaskForm
                  projects={projects}
                  defaultProjectId={selectedProjectId ?? undefined}
                  onSubmit={handleCreate}
                  onCancel={() => setModal({ kind: 'none' })}
                  submitLabel="Create Task"
                />
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
