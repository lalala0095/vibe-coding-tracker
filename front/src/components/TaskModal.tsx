import { useState, useEffect, useCallback } from 'react';
import type { Task, Project, TaskStatus, TaskPriority, CreateTaskPayload } from '../types';
import { getTasks, updateTask, deleteTask, createTask } from '../api';
import TaskForm from './TaskForm';

interface Props {
  task: Task;
  projects: Project[];
  onClose: () => void;
  onUpdated: (task: Task) => void;
  onDeleted: (id: string) => void;
}

const PRIORITY_DOT: Record<TaskPriority, string> = {
  low: 'bg-slate-400',
  medium: 'bg-blue-400',
  high: 'bg-orange-400',
  urgent: 'bg-red-400',
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

const PRIORITY_TEXT: Record<TaskPriority, string> = {
  low: 'text-slate-400',
  medium: 'text-blue-400',
  high: 'text-orange-400',
  urgent: 'text-red-400',
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
};

const STATUS_TEXT: Record<TaskStatus, string> = {
  todo: 'text-slate-400',
  in_progress: 'text-blue-400',
  done: 'text-green-400',
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  const d = new Date(Number(year), Number(month) - 1, Number(day));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

export default function TaskModal({ task, projects, onClose, onUpdated, onDeleted }: Props) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [loadingSubtasks, setLoadingSubtasks] = useState(false);
  const [showSubtaskForm, setShowSubtaskForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState<string | null>(null);
  const [openedSubtask, setOpenedSubtask] = useState<Task | null>(null);

  const fetchSubtasks = useCallback(async () => {
    setLoadingSubtasks(true);
    try {
      const data = await getTasks({ parent_task_id: task.id });
      setSubtasks(data);
    } catch {
      // silently fail
    } finally {
      setLoadingSubtasks(false);
    }
  }, [task.id]);

  useEffect(() => {
    fetchSubtasks();
  }, [fetchSubtasks]);

  const handleUpdate = async (data: CreateTaskPayload & { files: File[] }) => {
    const { files, ...payload } = data;
    const updated = await updateTask(task.id, payload, files);
    onUpdated(updated);
    setMode('view');
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteTask(task.id);
      onDeleted(task.id);
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleSubtaskCreate = async (data: CreateTaskPayload & { files: File[] }) => {
    const { files, ...payload } = data;
    await createTask(payload, files);
    setShowSubtaskForm(false);
    fetchSubtasks();
  };

  const cycleSubtaskStatus = async (subtask: Task) => {
    const next: TaskStatus =
      subtask.status === 'todo' ? 'in_progress' :
      subtask.status === 'in_progress' ? 'done' : 'todo';
    setTogglingStatus(subtask.id);
    try {
      const updated = await updateTask(subtask.id, { status: next }, []);
      setSubtasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch {
      // silently fail
    } finally {
      setTogglingStatus(null);
    }
  };

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        className="relative w-full max-w-2xl max-h-[92vh] bg-slate-900 border border-slate-800
                   rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full
              bg-slate-800 border border-slate-700 ${STATUS_TEXT[task.status]}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                task.status === 'todo' ? 'bg-slate-400' :
                task.status === 'in_progress' ? 'bg-blue-400' : 'bg-green-400'
              }`} />
              {STATUS_LABEL[task.status]}
            </span>
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full
              bg-slate-800 border border-slate-700 ${PRIORITY_TEXT[task.priority]}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[task.priority]}`} />
              {PRIORITY_LABEL[task.priority]}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-2">
            {mode === 'view' && (
              <>
                <button
                  onClick={() => setMode('edit')}
                  className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 border border-slate-700
                             rounded-lg hover:bg-slate-700 transition-colors"
                >
                  Edit
                </button>
                {!confirmDelete ? (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="px-3 py-1.5 text-xs font-medium text-red-400 bg-red-400/10 border border-red-400/20
                               rounded-lg hover:bg-red-400/20 transition-colors"
                  >
                    Delete
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400">Sure?</span>
                    <button
                      onClick={handleDelete}
                      disabled={deleting}
                      className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 rounded-lg
                                 hover:bg-red-500 transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                      {deleting && (
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      )}
                      Yes, delete
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      No
                    </button>
                  </div>
                )}
              </>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {mode === 'edit' ? (
            <TaskForm
              projects={projects}
              initialValues={task}
              onSubmit={handleUpdate}
              onCancel={() => setMode('view')}
              submitLabel="Save Changes"
            />
          ) : (
            <div className="flex flex-col gap-6">
              {/* Title */}
              <div>
                <h2 className={`text-xl font-semibold leading-snug ${
                  task.status === 'done' ? 'line-through text-slate-500' : 'text-slate-100'
                }`}>
                  {task.title}
                </h2>
                <p className="text-sm text-slate-500 mt-1">
                  {task.client_name} / {task.project_name}
                </p>
              </div>

              {/* Meta grid */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                {task.due_date && (
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Due Date</p>
                    <p className={`font-medium ${dueDateColor(task.due_date)}`}>
                      {formatDate(task.due_date)}
                    </p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Created</p>
                  <p className="text-slate-300">
                    {new Date(task.datetime_inserted).toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </p>
                </div>
                {task.datetime_updated !== task.datetime_inserted && (
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Updated</p>
                    <p className="text-slate-300">
                      {new Date(task.datetime_updated).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </p>
                  </div>
                )}
              </div>

              {/* Description */}
              {task.description && (
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Description</p>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
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

              {/* Subtasks */}
              <div>
                <div className="flex items-center justify-between mb-2">
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
                        className="flex items-center gap-3 px-3 py-2.5 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors cursor-pointer"
                        onClick={() => setOpenedSubtask(sub)}
                      >
                        {/* Status checkbox */}
                        <button
                          onClick={(e) => { e.stopPropagation(); cycleSubtaskStatus(sub); }}
                          disabled={togglingStatus === sub.id}
                          className={`w-4 h-4 rounded shrink-0 border-2 flex items-center justify-center transition-colors
                            ${sub.status === 'done'
                              ? 'bg-green-500 border-green-500'
                              : sub.status === 'in_progress'
                              ? 'border-blue-400 bg-blue-400/10'
                              : 'border-slate-600 bg-transparent hover:border-slate-400'
                            } disabled:opacity-50`}
                          title={`Status: ${STATUS_LABEL[sub.status]} — click to cycle`}
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

                        <span className={`flex-1 text-sm min-w-0 truncate ${
                          sub.status === 'done' ? 'line-through text-slate-500' : 'text-slate-200'
                        }`}>
                          {sub.title}
                        </span>

                        <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_DOT[sub.priority]}`} />

                        {sub.due_date && (
                          <span className={`text-xs shrink-0 ${dueDateColor(sub.due_date)}`}>
                            {formatDate(sub.due_date)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>

    {/* Nested modal for opening a subtask (supports infinite depth) */}
    {openedSubtask && (
      <TaskModal
        task={openedSubtask}
        projects={projects}
        onClose={() => setOpenedSubtask(null)}
        onUpdated={(updated) => {
          setSubtasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
          setOpenedSubtask(updated);
        }}
        onDeleted={(id) => {
          setSubtasks((prev) => prev.filter((t) => t.id !== id));
          setOpenedSubtask(null);
        }}
      />
    )}
    </>
  );
}
