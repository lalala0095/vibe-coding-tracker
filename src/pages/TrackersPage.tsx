import React, { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import {
  getTrackers, createTracker, updateTracker, deleteTracker,
  addTasksToTracker, removeTaskFromTracker,
  getTasks, getClients, getProjects,
} from '../api';
import type {
  Tracker, Task, Client, Project,
  CreateTrackerPayload, UpdateTrackerPayload,
  TrackerTaskRef,
} from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-SG', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}


function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  // datetime-local input expects "YYYY-MM-DDTHH:mm"
  return iso.slice(0, 16);
}

function nowLocalInputValue(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// Convert a datetime-local string to a full ISO-8601 string with offset.
// Since we work in SGT (UTC+8) we append +08:00 if no offset is present.
function toISOWithOffset(local: string): string {
  if (!local) return '';
  if (local.includes('+') || local.toLowerCase().includes('z')) return local;
  return `${local}:00+08:00`;
}

// ── Tracker Form Modal ────────────────────────────────────────────────────────

interface TrackerFormProps {
  initial?: Tracker;
  onSave: (payload: CreateTrackerPayload) => Promise<void>;
  onClose: () => void;
}

function TrackerForm({ initial, onSave, onClose }: TrackerFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [startTime, setStartTime] = useState(
    initial ? toLocalInputValue(initial.start_time) : nowLocalInputValue()
  );
  const [endTime, setEndTime] = useState(toLocalInputValue(initial?.end_time ?? null));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !startTime) { setErr('Title and start time are required.'); return; }
    setSaving(true);
    try {
      const payload: CreateTrackerPayload = {
        title: title.trim(),
        start_time: toISOWithOffset(startTime),
        ...(endTime ? { end_time: toISOWithOffset(endTime) } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      await onSave(payload);
      onClose();
    } catch {
      setErr('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
        <h2 className="text-lg font-semibold text-white mb-4">
          {initial ? 'Edit Tracker' : 'New Tracker'}
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Title</label>
            <input
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Tracker title"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Start time</label>
              <input
                type="datetime-local"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">End time (optional)</label>
              <input
                type="datetime-local"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Notes (optional)</label>
            <textarea
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-none"
              rows={3}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Any notes for this session…"
            />
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg text-slate-300 hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : initial ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add Tasks Modal ───────────────────────────────────────────────────────────

interface AddTasksModalProps {
  tracker: Tracker;
  allTasks: Task[];
  clients: Client[];
  projects: Project[];
  onAdd: (taskIds: string[]) => Promise<void>;
  onClose: () => void;
}

// ── Recursive task row used inside AddTasksModal ──────────────────────────────

interface TaskTreeRowProps {
  task: Task;
  depth: number;
  subtasksOf: Record<string, Task[]>;
  selected: Set<string>;
  existingIds: Set<string>;
  expandedTasks: Set<string>;
  onToggleExpand: (id: string) => void;
  onToggleSelect: (id: string) => void;
}

function TaskTreeRow({
  task, depth, subtasksOf, selected, existingIds, expandedTasks,
  onToggleExpand, onToggleSelect,
}: TaskTreeRowProps) {
  const subtasks = subtasksOf[task.id] ?? [];
  const hasSubtasks = subtasks.length > 0;
  const isExpanded = expandedTasks.has(task.id);
  const isExisting = existingIds.has(task.id);
  const isSelected = selected.has(task.id);

  return (
    <>
      <div
        className={`flex items-center gap-3 py-2.5 border-b border-slate-800/50 transition-colors group ${
          isExisting
            ? 'opacity-40 cursor-default'
            : isSelected
            ? 'bg-violet-500/10 cursor-pointer hover:bg-violet-500/15'
            : 'cursor-pointer hover:bg-slate-800/50'
        }`}
        style={{ paddingLeft: `${16 + depth * 20}px`, paddingRight: '16px' }}
        onClick={() => !isExisting && onToggleSelect(task.id)}
      >
        {/* Expand/collapse chevron */}
        {hasSubtasks ? (
          <button
            onClick={e => { e.stopPropagation(); onToggleExpand(task.id); }}
            className="w-4 h-4 shrink-0 text-slate-500 hover:text-slate-300 transition-colors"
          >
            <svg
              className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        ) : (
          <div className="w-4 shrink-0" />
        )}

        {/* Selection box */}
        <span className={`w-4 h-4 rounded shrink-0 border-2 flex items-center justify-center transition-colors ${
          isExisting
            ? 'border-slate-700 bg-slate-800'
            : isSelected
            ? 'bg-violet-500 border-violet-500'
            : 'border-slate-600 group-hover:border-slate-400'
        }`}>
          {isSelected && !isExisting && (
            <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          )}
          {isExisting && (
            <svg className="w-2.5 h-2.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          )}
        </span>

        {/* Title */}
        <span className={`flex-1 min-w-0 text-sm truncate ${isExisting ? 'text-slate-500' : 'text-slate-100'}`}>
          {task.title}
          {isExisting && <span className="ml-2 text-xs text-slate-600">(already added)</span>}
        </span>

        {/* Subtask count badge */}
        {hasSubtasks && (
          <span className="shrink-0 text-xs text-slate-500 bg-slate-800 border border-slate-700 rounded-full px-1.5 py-0.5">
            {subtasks.length}
          </span>
        )}

        {/* Status badge */}
        <span className={`shrink-0 text-xs font-medium px-1.5 py-0.5 rounded-full ${
          task.status === 'done' ? 'text-green-400 bg-green-400/10' :
          task.status === 'in_progress' ? 'text-blue-400 bg-blue-400/10' :
          'text-slate-500 bg-slate-800'
        }`}>
          {task.status === 'in_progress' ? 'In Progress' : task.status === 'done' ? 'Done' : 'Todo'}
        </span>
      </div>

      {/* Subtasks (recursive) */}
      {isExpanded && subtasks.map(sub => (
        <TaskTreeRow
          key={sub.id}
          task={sub}
          depth={depth + 1}
          subtasksOf={subtasksOf}
          selected={selected}
          existingIds={existingIds}
          expandedTasks={expandedTasks}
          onToggleExpand={onToggleExpand}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </>
  );
}

function AddTasksModal({ tracker, allTasks, clients, projects, onAdd, onClose }: AddTasksModalProps) {
  const existingIds = new Set(tracker.tasks.map(t => t.task_id));

  const [expandedClients, setExpandedClients] = useState<Set<string>>(
    () => new Set(clients.map(c => c.id))
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Build subtask map from allTasks (already fully loaded)
  const subtasksOf: Record<string, Task[]> = {};
  for (const t of allTasks) {
    if (t.parent_task_id) {
      if (!subtasksOf[t.parent_task_id]) subtasksOf[t.parent_task_id] = [];
      subtasksOf[t.parent_task_id].push(t);
    }
  }

  // Top-level tasks, filtered by selected project
  const topLevelTasks = allTasks.filter(t =>
    !t.parent_task_id &&
    (selectedProjectId ? t.project_id === selectedProjectId : true)
  );

  const clientProjectGroups = clients.map(c => ({
    client: c,
    projects: projects.filter(p => p.client_id === c.id),
  }));

  function toggleClient(clientId: string) {
    setExpandedClients(prev => {
      const next = new Set(prev);
      next.has(clientId) ? next.delete(clientId) : next.add(clientId);
      return next;
    });
  }

  function toggleTaskExpand(id: string) {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleTaskSelect(id: string) {
    if (existingIds.has(id)) return;
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleAdd() {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      await onAdd(Array.from(selected));
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden" style={{ maxHeight: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <h2 className="text-base font-semibold text-white">Add tasks to tracker</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body: sidebar + task tree */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: client/project tree */}
          <aside className="w-48 shrink-0 border-r border-slate-800 overflow-y-auto bg-slate-950/50">
            <nav className="flex flex-col py-2">
              <button
                onClick={() => setSelectedProjectId(null)}
                className={`flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                  selectedProjectId === null
                    ? 'text-violet-400 bg-violet-400/10 font-medium'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                }`}
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                </svg>
                All Tasks
              </button>

              {clientProjectGroups.map(({ client, projects: cProjects }) => (
                <div key={client.id}>
                  <button
                    onClick={() => toggleClient(client.id)}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors text-left uppercase tracking-wider"
                  >
                    <svg
                      className={`w-3 h-3 shrink-0 transition-transform ${expandedClients.has(client.id) ? 'rotate-90' : ''}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                    <span className="truncate">{client.name}</span>
                  </button>

                  {expandedClients.has(client.id) && cProjects.map(p => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedProjectId(p.id)}
                      className={`w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-sm text-left transition-colors ${
                        selectedProjectId === p.id
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
          </aside>

          {/* Right: task tree */}
          <div className="flex-1 overflow-y-auto">
            {topLevelTasks.length === 0 ? (
              <div className="flex items-center justify-center h-full text-sm text-slate-500">
                No tasks available.
              </div>
            ) : (
              topLevelTasks.map(t => (
                <TaskTreeRow
                  key={t.id}
                  task={t}
                  depth={0}
                  subtasksOf={subtasksOf}
                  selected={selected}
                  existingIds={existingIds}
                  expandedTasks={expandedTasks}
                  onToggleExpand={toggleTaskExpand}
                  onToggleSelect={toggleTaskSelect}
                />
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700 shrink-0 bg-slate-900">
          <span className="text-xs text-slate-400">
            {selected.size > 0 ? `${selected.size} task${selected.size !== 1 ? 's' : ''} selected` : 'Click tasks to select'}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg text-slate-300 hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={saving || selected.size === 0}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
            >
              {saving ? 'Adding…' : `Add${selected.size > 0 ? ` (${selected.size})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tracker Panel (right-side detail) ────────────────────────────────────────

interface TrackerPanelProps {
  tracker: Tracker;
  onEdit: () => void;
  onDelete: () => void;
  onStop: () => void;
  onAddTasks: () => void;
  onRemoveTask: (taskId: string) => void;
}

function TrackerPanel({ tracker, onEdit, onDelete, onStop, onAddTasks, onRemoveTask }: TrackerPanelProps) {
  const isActive = !tracker.end_time;
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-700/60">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {isActive && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400 bg-green-400/10 border border-green-400/20 rounded-full px-2 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  Active
                </span>
              )}
            </div>
            <h2 className="text-base font-semibold text-white leading-snug">{tracker.title}</h2>
            <p className="text-xs text-slate-400 mt-1">
              {formatDateTime(tracker.start_time)}
              {tracker.end_time ? ` → ${formatDateTime(tracker.end_time)}` : ' → now'}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {isActive && (
              <button
                onClick={onStop}
                className="px-2.5 py-1 text-xs rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400 hover:bg-orange-500/20 transition-colors font-medium"
              >
                Stop
              </button>
            )}
            <button
              onClick={onEdit}
              className="px-2.5 py-1 text-xs rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-white transition-colors"
            >
              Edit
            </button>
            <button
              onClick={onDelete}
              className="px-2.5 py-1 text-xs rounded-lg bg-slate-800 border border-slate-700 text-red-400 hover:text-red-300 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
        {tracker.notes && (
          <p className="mt-3 text-sm text-slate-300 whitespace-pre-wrap">{tracker.notes}</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Tasks section */}
        <div className="px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Tasks ({tracker.tasks.length})
            </h3>
            <button
              onClick={onAddTasks}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              + Add tasks
            </button>
          </div>
          {tracker.tasks.length === 0 ? (
            <p className="text-xs text-slate-500">No tasks linked yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {tracker.tasks.map((t: TrackerTaskRef) => (
                <div
                  key={t.task_id}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/60 group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-200 truncate">{t.task_title}</p>
                    <p className="text-xs text-slate-500 truncate">{t.client_name} / {t.project_name}</p>
                  </div>
                  <button
                    onClick={() => navigate('/tasks', { state: { openTaskId: t.task_id } })}
                    className="shrink-0 text-slate-600 hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-all"
                    title="Open task in Tasks page"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onRemoveTask(t.task_id)}
                    className="shrink-0 text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                    title="Remove task from tracker"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type ModalState =
  | { kind: 'none' }
  | { kind: 'create_tracker' }
  | { kind: 'edit_tracker'; tracker: Tracker }
  | { kind: 'add_tasks'; tracker: Tracker };

export default function TrackersPage() {
  const { user, logout } = useAuth();

  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'done'>('all');

  const [selectedTracker, setSelectedTracker] = useState<Tracker | null>(null);

  const [modal, setModal] = useState<ModalState>({ kind: 'none' });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [trackersData, tasksData, clientsData, projectsData] = await Promise.all([
        getTrackers(),
        getTasks(),
        getClients(),
        getProjects(),
      ]);
      setTrackers(trackersData);
      setTasks(tasksData);
      setClients(clientsData);
      setProjects(projectsData);
    } catch {
      setError('Failed to load data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  function openTracker(t: Tracker) {
    setSelectedTracker(t);
  }

  const filteredTrackers = trackers.filter(t => {
    if (filterActive === 'active') return !t.end_time;
    if (filterActive === 'done') return !!t.end_time;
    return true;
  });

  // ── Tracker actions ──

  async function handleCreateTracker(payload: CreateTrackerPayload) {
    const created = await createTracker(payload);
    setTrackers(prev => [created, ...prev]);
  }

  async function handleUpdateTracker(payload: UpdateTrackerPayload) {
    if (!selectedTracker) return;
    const updated = await updateTracker(selectedTracker.id, payload);
    setTrackers(prev => prev.map(t => t.id === updated.id ? updated : t));
    setSelectedTracker(updated);
  }

  async function handleStopTracker(tracker: Tracker) {
    const now = new Date().toISOString();
    const updated = await updateTracker(tracker.id, { end_time: now });
    setTrackers(prev => prev.map(t => t.id === updated.id ? updated : t));
    if (selectedTracker?.id === updated.id) setSelectedTracker(updated);
  }

  async function handleDeleteTracker(tracker: Tracker) {
    if (!confirm(`Delete tracker "${tracker.title}"?`)) return;
    await deleteTracker(tracker.id);
    setTrackers(prev => prev.filter(t => t.id !== tracker.id));
    if (selectedTracker?.id === tracker.id) setSelectedTracker(null);
  }

  async function handleAddTasks(taskIds: string[]) {
    if (!selectedTracker) return;
    const updated = await addTasksToTracker(selectedTracker.id, taskIds);
    setTrackers(prev => prev.map(t => t.id === updated.id ? updated : t));
    setSelectedTracker(updated);
  }

  async function handleRemoveTask(taskId: string) {
    if (!selectedTracker) return;
    const updated = await removeTaskFromTracker(selectedTracker.id, taskId);
    setTrackers(prev => prev.map(t => t.id === updated.id ? updated : t));
    setSelectedTracker(updated);
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* ── Navigation Header ── */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-sm border-b border-slate-800 shrink-0">
        <div className="w-full px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <Link to="/dashboard" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <span className="text-base font-semibold text-slate-100 hidden sm:block">Vibe Coding Tracker</span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link to="/dashboard" className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors">Sessions</Link>
            <Link to="/tasks" className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors">Tasks</Link>
            <Link to="/trackers" className="px-3 py-1.5 text-sm text-slate-100 bg-slate-800 rounded-lg transition-colors font-medium">Trackers</Link>
            <Link to="/models" className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors">Models</Link>
            <Link to="/manage" className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors">Clients &amp; Projects</Link>
            {user?.picture ? (
              <img src={user.picture} alt={user.name ?? 'User'} className="w-8 h-8 rounded-full border border-slate-700 ml-1" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs text-slate-300 ml-1">
                {user?.name?.[0] ?? user?.email?.[0] ?? '?'}
              </div>
            )}
            <button onClick={logout} className="px-3 py-1.5 text-sm text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors">Sign out</button>
          </nav>
        </div>
      </header>

      {/* ── Body: two-column layout ── */}
      <div className="flex flex-1 overflow-hidden">
      {/* ── Left column: tracker list ── */}
      <div className="flex flex-col w-96 border-r border-slate-800 shrink-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <span className="text-sm font-semibold text-white">Trackers</span>
          <button
            onClick={() => setModal({ kind: 'create_tracker' })}
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
          >
            + New
          </button>
        </div>

        {/* Filters */}
        <div className="flex gap-1 px-4 py-2.5 border-b border-slate-800/60">
          {(['all', 'active', 'done'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilterActive(f)}
              className={`px-3 py-1 text-xs rounded-full font-medium transition-colors capitalize ${
                filterActive === f
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {f === 'active' ? 'Active' : f === 'done' ? 'Completed' : 'All'}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-sm text-slate-500">Loading…</div>
          ) : error ? (
            <div className="p-6 text-sm text-red-400">{error}</div>
          ) : filteredTrackers.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">
              {filterActive === 'all' ? 'No trackers yet. Create one!' : 'No trackers here.'}
            </div>
          ) : (
            filteredTrackers.map(t => {
              const isActive = !t.end_time;
              const isSelected = selectedTracker?.id === t.id;
              return (
                <div
                  key={t.id}
                  onClick={() => openTracker(t)}
                  className={`flex flex-col gap-1 px-4 py-3 border-b border-slate-800/50 cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-slate-800 border-l-2 border-l-blue-500'
                      : 'hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {isActive && (
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0 animate-pulse" />
                    )}
                    <span className="text-sm font-medium text-slate-100 truncate flex-1">
                      {t.title}
                    </span>
                    {t.tasks.length > 0 && (
                      <span className="text-xs text-slate-500 shrink-0">
                        {t.tasks.length} task{t.tasks.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    {formatDateTime(t.start_time)}
                    {t.end_time
                      ? ` → ${formatDateTime(t.end_time)}`
                      : ' → now'}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Right panel: tracker detail ── */}
      <div className="flex-1 overflow-hidden">
        {selectedTracker ? (
          <TrackerPanel
            tracker={selectedTracker}
            onEdit={() => setModal({ kind: 'edit_tracker', tracker: selectedTracker })}
            onDelete={() => handleDeleteTracker(selectedTracker)}
            onStop={() => handleStopTracker(selectedTracker)}
            onAddTasks={() => setModal({ kind: 'add_tasks', tracker: selectedTracker })}
            onRemoveTask={handleRemoveTask}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">
            Select a tracker to view details
          </div>
        )}
      </div>

      {/* ── Modals ── */}
      {modal.kind === 'create_tracker' && (
        <TrackerForm
          onSave={handleCreateTracker}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'edit_tracker' && (
        <TrackerForm
          initial={modal.tracker}
          onSave={handleUpdateTracker}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'add_tasks' && (
        <AddTasksModal
          tracker={modal.tracker}
          allTasks={tasks}
          clients={clients}
          projects={projects}
          onAdd={handleAddTasks}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
      </div>
    </div>
  );
}
