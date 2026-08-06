import { useState, useEffect, useCallback } from 'react';
import type { Task, Project, Model, Goal, TaskStatus, TaskPriority, CreateTaskPayload } from '../types';
import { getTasks, updateTask, deleteTask, createTask, getGoals, createGoal, updateGoal, deleteGoal } from '../api';
import TaskForm from './TaskForm';
import GoalForm from './GoalForm';
import TimeEntryList from './TimeEntryList';
import ConfirmDialog from './ConfirmDialog';

interface Props {
  task: Task;
  projects: Project[];
  models: Model[];
  onClose: () => void;
  onUpdated: (task: Task) => void;
  onDeleted: (id: string) => void;
  onSessionOpen?: (goal: Goal) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PRIORITY_DOT: Record<TaskPriority, string> = {
  low: 'bg-slate-400',
  medium: 'bg-blue-400',
  high: 'bg-orange-400',
  urgent: 'bg-red-400',
};

const PRIORITY_TEXT: Record<TaskPriority, string> = {
  low: 'text-slate-400',
  medium: 'text-blue-400',
  high: 'text-orange-400',
  urgent: 'text-red-400',
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent',
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Todo', in_progress: 'In Progress', done: 'Done',
};

const STATUS_TEXT: Record<TaskStatus, string> = {
  todo: 'text-slate-400', in_progress: 'text-blue-400', done: 'text-green-400',
};

const STATUS_DOT: Record<TaskStatus, string> = {
  todo: 'bg-slate-400', in_progress: 'bg-blue-400', done: 'bg-green-500',
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function dueDateColor(dateStr: string | null): string {
  if (!dateStr) return 'text-slate-500';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateStr.split('-');
  const due = new Date(Number(y), Number(m) - 1, Number(d));
  if (due < today) return 'text-red-400';
  if (due.getTime() === today.getTime()) return 'text-orange-400';
  return 'text-slate-400';
}

// ── Panel view for a single task ──────────────────────────────────────────────

interface TaskViewProps {
  task: Task;
  projects: Project[];
  models: Model[];
  onNavigate: (task: Task) => void;
  onUpdated: (task: Task) => void;
  onDeleted: (id: string) => void;
  onSessionOpen?: (goal: Goal) => void;
}

function TaskView({ task, projects, models, onNavigate, onUpdated, onDeleted, onSessionOpen }: TaskViewProps) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [loadingSubtasks, setLoadingSubtasks] = useState(false);
  const [showSubtaskForm, setShowSubtaskForm] = useState(false);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Goal[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [showSessionForm, setShowSessionForm] = useState(false);
  const [editingSession, setEditingSession] = useState<Goal | null>(null);
  // One nullable target for the whole list, not a flag per row — a dialog per
  // row would mount one for every session.
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<Goal | null>(null);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [loadingAllTasks, setLoadingAllTasks] = useState(false);

  const fetchSubtasks = useCallback(async () => {
    setLoadingSubtasks(true);
    try {
      setSubtasks(await getTasks({ parent_task_id: task.id }));
    } catch { /* silent */ }
    finally { setLoadingSubtasks(false); }
  }, [task.id]);

  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      setSessions(await getGoals({ task_id: task.id }));
    } catch { /* silent */ }
    finally { setLoadingSessions(false); }
  }, [task.id]);

  useEffect(() => { fetchSubtasks(); fetchSessions(); }, [fetchSubtasks, fetchSessions]);

  // Reset to view mode when task changes (navigating)
  useEffect(() => {
    setMode('view');
    setShowSubtaskForm(false);
    setShowSessionForm(false);
    setEditingSession(null);
  }, [task.id]);

  const handleUpdate = async (data: CreateTaskPayload & { files: File[] }) => {
    const { files, ...payload } = data;
    const updated = await updateTask(task.id, payload, files);
    onUpdated(updated);
    setMode('view');
  };

  // No try/catch: a failure has to reach ConfirmDialog, which keeps itself open
  // and shows the message.
  const handleDelete = async () => {
    await deleteTask(task.id);
    onDeleted(task.id);
  };

  const handleSubtaskCreate = async (data: CreateTaskPayload & { files: File[] }) => {
    const { files, ...payload } = data;
    const created = await createTask(payload, files);
    setSubtasks((prev) => [...prev, created]);
    setShowSubtaskForm(false);
  };

  const cycleSubtaskStatus = async (sub: Task) => {
    const next: TaskStatus =
      sub.status === 'todo' ? 'in_progress' :
      sub.status === 'in_progress' ? 'done' : 'todo';
    setTogglingId(sub.id);
    try {
      const updated = await updateTask(sub.id, { status: next }, []);
      setSubtasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch { /* silent */ }
    finally { setTogglingId(null); }
  };

  const handleSessionCreate = async (data: { model_id: string; goal: string; output: string; task_id?: string; files: File[] }) => {
    const { files, ...payload } = data;
    const created = await createGoal({ ...payload, task_id: task.id }, files);
    setSessions((prev) => [created, ...prev]);
    setShowSessionForm(false);
  };

  const openSessionEdit = async (session: Goal) => {
    setEditingSession(session);
    setShowSessionForm(false);
    if (allTasks.length === 0 && !loadingAllTasks) {
      setLoadingAllTasks(true);
      try {
        const data = await getTasks();
        setAllTasks(data.filter((t) => !t.parent_task_id));
      } catch { /* silent */ }
      finally { setLoadingAllTasks(false); }
    }
  };

  const handleSessionUpdate = async (data: { model_id: string; goal: string; output: string; task_id?: string; files: File[] }) => {
    if (!editingSession) return;
    const { files, ...payload } = data;
    await updateGoal(editingSession.id, payload, files);
    // If remapped to a different task (or unlinked), remove from this task's list
    if (payload.task_id !== task.id) {
      setSessions((prev) => prev.filter((s) => s.id !== editingSession.id));
    } else {
      await fetchSessions();
    }
    setEditingSession(null);
  };

  // Called from ConfirmDialog. It used to run straight off the row's click with
  // no confirmation and no error path at all; the throw now reaches the dialog.
  const handleSessionDelete = async (session: Goal) => {
    await deleteGoal(session.id);
    setSessions((prev) => prev.filter((s) => s.id !== session.id));
  };

  if (mode === 'edit') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 shrink-0">
          <span className="text-sm font-semibold text-slate-100">Edit Task</span>
          <button
            onClick={() => setMode('view')}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors px-2 py-1 hover:bg-slate-800 rounded-lg"
          >
            Cancel
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <TaskForm
            projects={projects}
            initialValues={task}
            onSubmit={handleUpdate}
            onCancel={() => setMode('view')}
            submitLabel="Save Changes"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setMode('edit')}
            className="px-2.5 py-1 text-xs font-medium text-slate-300 bg-slate-800 border border-slate-700
                       rounded-lg hover:bg-slate-700 transition-colors"
          >
            Edit
          </button>
          <button
            onClick={() => setConfirmDeleteTask(true)}
            className="px-2.5 py-1 text-xs font-medium text-red-400 bg-red-400/10 border border-red-400/20
                       rounded-lg hover:bg-red-400/20 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteTask}
        title="Delete task"
        message={<>Delete <span className="text-slate-100 font-medium">{task.title}</span>?</>}
        onConfirm={handleDelete}
        onClose={() => setConfirmDeleteTask(false)}
      />

      {/* Content */}
      <div className="flex flex-col gap-5 p-5">
        {/* Title */}
        <div>
          <h2 className={`text-lg font-semibold leading-snug ${
            task.status === 'done' ? 'line-through text-slate-500' : 'text-slate-100'
          }`}>
            {task.title}
          </h2>
          <p className="text-xs text-slate-500 mt-1">{task.client_name} / {task.project_name}</p>
        </div>

        {/* Status + Priority */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full
            bg-slate-800 border border-slate-700 ${STATUS_TEXT[task.status]}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[task.status]}`} />
            {STATUS_LABEL[task.status]}
          </span>
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full
            bg-slate-800 border border-slate-700 ${PRIORITY_TEXT[task.priority]}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[task.priority]}`} />
            {PRIORITY_LABEL[task.priority]}
          </span>
          {task.due_date && (
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full
              bg-slate-800 border border-slate-700 ${dueDateColor(task.due_date)}`}>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
              </svg>
              {formatDate(task.due_date)}
            </span>
          )}
        </div>

        {/* Description */}
        {task.description && (
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Description</p>
            <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed bg-slate-800/50 rounded-lg p-3">
              {task.description}
            </p>
          </div>
        )}

        {/* Attachments */}
        {task.attachments && task.attachments.length > 0 && (
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">
              Attachments ({task.attachments.length})
            </p>
            <ul className="flex flex-col gap-1.5">
              {task.attachments.map((att) => (
                <li key={att.gcs_url}>
                  <a
                    href={att.gcs_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-3 py-2 bg-slate-800 rounded-lg text-sm
                               text-violet-400 hover:text-violet-300 hover:bg-slate-700 transition-colors"
                  >
                    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round"
                        d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                    </svg>
                    <span className="truncate">{att.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="bg-slate-800/50 rounded-lg p-3">
            <p className="text-slate-500 mb-1">Created</p>
            <p className="text-slate-300">
              {new Date(task.datetime_inserted).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              })}
            </p>
          </div>
          {task.datetime_updated !== task.datetime_inserted && (
            <div className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-slate-500 mb-1">Updated</p>
              <p className="text-slate-300">
                {new Date(task.datetime_updated).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric',
                })}
              </p>
            </div>
          )}
        </div>

        {/* Subtasks */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-500 uppercase tracking-wider">
              Subtasks{subtasks.length > 0 ? ` (${subtasks.length})` : ''}
            </p>
            <button
              onClick={() => setShowSubtaskForm((v) => !v)}
              className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add Subtask
            </button>
          </div>

          {showSubtaskForm && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-3">
              <TaskForm
                projects={projects}
                defaultProjectId={task.project_id}
                defaultParentTaskId={task.id}
                onSubmit={handleSubtaskCreate}
                onCancel={() => setShowSubtaskForm(false)}
                submitLabel="Add Subtask"
              />
            </div>
          )}

          {loadingSubtasks ? (
            <div className="flex items-center gap-2 py-3 text-sm text-slate-500">
              <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
              Loading subtasks…
            </div>
          ) : subtasks.length === 0 ? (
            <p className="text-sm text-slate-600 py-2">No subtasks yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {subtasks.map((sub) => (
                <li
                  key={sub.id}
                  className="flex items-center gap-3 px-3 py-2.5 bg-slate-800 rounded-lg
                             hover:bg-slate-700 transition-colors cursor-pointer group"
                  onClick={() => onNavigate(sub)}
                >
                  {/* Status checkbox */}
                  <button
                    onClick={(e) => { e.stopPropagation(); cycleSubtaskStatus(sub); }}
                    disabled={togglingId === sub.id}
                    className={`w-4 h-4 rounded shrink-0 border-2 flex items-center justify-center transition-colors
                      ${sub.status === 'done'
                        ? 'bg-green-500 border-green-500'
                        : sub.status === 'in_progress'
                        ? 'border-blue-400 bg-blue-400/10'
                        : 'border-slate-600 hover:border-slate-400'
                      } disabled:opacity-50`}
                  >
                    {sub.status === 'done' && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    )}
                    {sub.status === 'in_progress' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                    )}
                  </button>

                  {/* Priority dot */}
                  <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_DOT[sub.priority]}`} />

                  {/* Title */}
                  <span className={`flex-1 text-sm min-w-0 truncate ${
                    sub.status === 'done' ? 'line-through text-slate-500' : 'text-slate-200 group-hover:text-slate-100'
                  }`}>
                    {sub.title}
                  </span>

                  {/* Due date */}
                  {sub.due_date && (
                    <span className={`text-xs shrink-0 ${dueDateColor(sub.due_date)}`}>
                      {formatDate(sub.due_date)}
                    </span>
                  )}

                  {/* Drill-in chevron */}
                  <svg
                    className="w-3.5 h-3.5 text-slate-600 group-hover:text-slate-400 shrink-0 transition-colors"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Time Entries — the `sessions` API. Not the "Sessions" block below. */}
        <TimeEntryList taskId={task.id} />

        {/* Sessions */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-500 uppercase tracking-wider">
              Sessions{sessions.length > 0 ? ` (${sessions.length})` : ''}
            </p>
            {models.length > 0 && (
              <button
                onClick={() => setShowSessionForm((v) => !v)}
                className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Add Session
              </button>
            )}
          </div>

          {showSessionForm && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-3">
              <GoalForm
                models={models}
                defaultTaskId={task.id}
                onSubmit={handleSessionCreate}
                onCancel={() => setShowSessionForm(false)}
                submitLabel="Add Session"
              />
            </div>
          )}

          {loadingSessions ? (
            <div className="flex items-center gap-2 py-3 text-sm text-slate-500">
              <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
              Loading sessions…
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-slate-600 py-2">No sessions linked yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {sessions.map((s) => (
                <li key={s.id} className="bg-slate-800 rounded-lg overflow-hidden">
                  {editingSession?.id === s.id ? (
                    <div className="p-3">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-semibold text-slate-300">Edit Session</span>
                        <button
                          onClick={() => setEditingSession(null)}
                          className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                      {loadingAllTasks ? (
                        <div className="flex items-center gap-2 py-3 text-sm text-slate-500">
                          <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                          Loading tasks…
                        </div>
                      ) : (
                        <GoalForm
                          models={models}
                          tasks={allTasks}
                          initialValues={s}
                          onSubmit={handleSessionUpdate}
                          onCancel={() => setEditingSession(null)}
                          submitLabel="Save Changes"
                        />
                      )}
                    </div>
                  ) : (
                    <div
                      onClick={() => onSessionOpen?.(s)}
                      className={`px-3 py-2.5 ${
                        onSessionOpen ? 'cursor-pointer hover:bg-slate-700 transition-colors group' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-violet-400 shrink-0">{s.model_name}</span>
                        <span className="text-xs text-slate-600">
                          {new Date(s.datetime_inserted).toLocaleDateString('en-SG', {
                            month: 'short', day: 'numeric', year: 'numeric',
                            timeZone: 'Asia/Singapore',
                          })}
                        </span>
                        <div className="ml-auto flex items-center gap-1 shrink-0">
                          <button
                            onClick={(e) => { e.stopPropagation(); openSessionEdit(s); }}
                            className="px-1.5 py-0.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-600 rounded transition-colors"
                            title="Edit session"
                          >
                            Edit
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteSession(s); }}
                            className="px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded transition-colors"
                            title="Delete session"
                          >
                            Delete
                          </button>
                          {onSessionOpen && (
                            <svg
                              className="w-3 h-3 text-slate-600 group-hover:text-slate-400 transition-colors"
                              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                            </svg>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">{s.goal}</p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteSession !== null}
        title="Delete session"
        message={
          <>
            Delete the{' '}
            <span className="text-slate-100 font-medium">{confirmDeleteSession?.model_name}</span>{' '}
            session?
          </>
        }
        detail={<span className="line-clamp-3">{confirmDeleteSession?.goal}</span>}
        onConfirm={async () => {
          if (confirmDeleteSession) await handleSessionDelete(confirmDeleteSession);
        }}
        onClose={() => setConfirmDeleteSession(null)}
      />
    </div>
  );
}

// ── TaskPanel — slide-in panel with navigation stack ─────────────────────────

export default function TaskPanel({ task, projects, models, onClose, onUpdated, onDeleted, onSessionOpen }: Props) {
  // Navigation stack — [root, subtask, sub-subtask, ...]
  const [stack, setStack] = useState<Task[]>([task]);

  // If the root task changes from outside (e.g. switching tasks in the list), reset stack
  useEffect(() => {
    setStack([task]);
  }, [task.id]);

  const currentTask = stack[stack.length - 1];

  const navigateTo = (sub: Task) => setStack((prev) => [...prev, sub]);

  const navigateBack = () => setStack((prev) => prev.slice(0, -1));

  const navigateTo_breadcrumb = (index: number) =>
    setStack((prev) => prev.slice(0, index + 1));

  // Propagate updates: update every occurrence in the stack
  const handleUpdated = (updated: Task) => {
    setStack((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    onUpdated(updated);
  };

  // On delete, if deleting something mid-stack, go back; if root, close panel
  const handleDeleted = (id: string) => {
    const idx = stack.findIndex((t) => t.id === id);
    if (idx === 0) {
      onDeleted(id);
    } else {
      setStack((prev) => prev.slice(0, idx));
      onDeleted(id);
    }
  };

  return (
    <aside className="w-1/2 shrink-0 border-l border-slate-800 bg-slate-900 flex flex-col h-full overflow-hidden">
      {/* Panel header — breadcrumb + close */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800 shrink-0 min-h-[52px]">
        {/* Back button */}
        {stack.length > 1 && (
          <button
            onClick={navigateBack}
            className="p-1 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors shrink-0"
            title="Go back"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
        )}

        {/* Breadcrumb trail */}
        <nav className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
          {stack.map((t, i) => (
            <div key={t.id} className="flex items-center gap-1 min-w-0">
              {i > 0 && (
                <svg className="w-3 h-3 text-slate-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              )}
              <button
                onClick={() => navigateTo_breadcrumb(i)}
                className={`text-xs truncate max-w-[120px] transition-colors ${
                  i === stack.length - 1
                    ? 'text-slate-100 font-medium cursor-default'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title={t.title}
              >
                {t.title}
              </button>
            </div>
          ))}
        </nav>

        {/* Close button */}
        <button
          onClick={onClose}
          className="p-1 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors shrink-0 ml-1"
          title="Close panel"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Panel body — renders current task in stack */}
      <div className="flex-1 overflow-hidden">
        <TaskView
          key={currentTask.id}
          task={currentTask}
          projects={projects}
          models={models}
          onNavigate={navigateTo}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
          onSessionOpen={onSessionOpen}
        />
      </div>
    </aside>
  );
}
