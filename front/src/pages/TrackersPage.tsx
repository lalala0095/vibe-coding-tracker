import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import AppNav from '../components/AppNav';
import DateTimeInput from '../components/DateTimeInput';
import Modal, { MODAL_CANCEL_BUTTON, MODAL_PRIMARY_BUTTON } from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import WeeklySummaryPane from '../components/WeeklySummaryPane';
import {
  getTrackers, createTracker, updateTracker, deleteTracker,
  addTasksToTracker, removeTaskFromTracker, billTracker,
  getTasks, getClients, getProjects, createTasksBulk, getSessions, getInvoices,
  getTrackerSettings, getInvoiceSettings,
} from '../api';
import { parseTaskList } from '../lib/taskPaste';
import { renderTrackerName } from '../lib/trackerName';
import { recentWeekStarts } from '../lib/week';
import { summariseWeeks } from '../lib/weeklySummary';
import type {
  Tracker, Task, Client, Project, TrackerSettings,
  CreateTrackerPayload, UpdateTrackerPayload,
  TrackerTaskRef, TaskStatus, TaskPriority,
  Session, InvoiceSettings, Invoice,
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

// The API answers a rejected write with a `detail` string worth showing verbatim
// ("Stop the tracker or supply 'hours' before billing it."). Anything else falls
// back to the caller's message. No request is made here — this only reads an
// error that api.ts already produced.
function errorDetail(e: unknown, fallback: string): string {
  if (axios.isAxiosError(e)) {
    const data: unknown = e.response?.data;
    if (data && typeof data === 'object' && 'detail' in data) {
      const detail = (data as { detail: unknown }).detail;
      if (typeof detail === 'string' && detail.trim()) return detail;
    }
  }
  return fallback;
}

// The moment a new tracker's name is rendered for: its own start time, so a
// backdated tracker is named for its own day rather than for today. A
// datetime-local value is read as local time, which is what the tokens want.
// An empty or half-typed field parses to Invalid Date and falls back to now.
function nameMoment(localStartTime: string): Date {
  const at = new Date(localStartTime);
  return Number.isNaN(at.getTime()) ? new Date() : at;
}

// What the stored template renders to, or '' when there is nothing to pre-fill
// with — settings that never loaded, auto-naming switched off, or a blank
// template. A pre-fill only; the field is the user's from that moment on.
function autoTrackerName(settings: TrackerSettings | null, localStartTime: string): string {
  if (!settings?.auto_name_enabled) return '';
  if (!settings.auto_name_template.trim()) return '';
  return renderTrackerName(settings.auto_name_template, nameMoment(localStartTime));
}

// A tracker's own span, in hours to 2dp. Null while it is still running — the
// server then requires the hours to be supplied by hand.
function elapsedHours(tracker: Tracker): number | null {
  if (!tracker.end_time) return null;
  const start = new Date(tracker.start_time).getTime();
  const end = new Date(tracker.end_time).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round(((end - start) / 3600000) * 100) / 100;
}

// ── Tracker Form Modal ────────────────────────────────────────────────────────

// Raw enum values read badly in a select, so each one carries a label.
const TASK_STATUSES: ReadonlyArray<readonly [TaskStatus, string]> = [
  ['todo', 'Todo'],
  ['in_progress', 'In progress'],
  ['done', 'Done'],
];

const TASK_PRIORITIES: ReadonlyArray<readonly [TaskPriority, string]> = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['urgent', 'Urgent'],
];

// The submit button lives in the modal footer, outside the <form>, so the two
// are linked by id. Only one TrackerForm is ever mounted (the modal state is a
// union), so a constant id cannot collide.
const FORM_ID = 'tracker-form';

interface TrackerFormProps {
  initial?: Tracker;
  // Only used on the create path, to pick the project the new task belongs to.
  projects?: Project[];
  // Best-effort: null when the settings never loaded, which costs the pre-filled
  // name and nothing else. Ignored when editing — a saved title is never touched.
  settings?: TrackerSettings | null;
  onSave: (payload: CreateTrackerPayload) => Promise<void>;
  onClose: () => void;
}

function TrackerForm({ initial, projects = [], settings = null, onSave, onClose }: TrackerFormProps) {
  const initialStartTime = initial ? toLocalInputValue(initial.start_time) : nowLocalInputValue();
  // Rendered once, at mount. There is deliberately no effect tying the name to
  // the start time: re-rendering it when the start time changes would rewrite a
  // title the user had already typed (§ no locking).
  const [title, setTitle] = useState(() =>
    initial ? initial.title : autoTrackerName(settings, initialStartTime)
  );
  // Whether the title is the user's now. Only ever set, never cleared, so no
  // later code path can decide the field is fair game again.
  const [titleEdited, setTitleEdited] = useState(false);
  const [startTime, setStartTime] = useState(initialStartTime);
  const [endTime, setEndTime] = useState(toLocalInputValue(initial?.end_time ?? null));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // ── Optional task created alongside the tracker ──
  // Only offered when starting a tracker: an existing tracker is not being
  // "started", so editing one leaves all of this out entirely.
  const isCreate = !initial;
  const [createTask, setCreateTask] = useState(false);
  const [taskProjectId, setTaskProjectId] = useState('');
  // Deliberately left empty when the tracker title was auto-named. "2026-08-07
  // tasks" is a reasonable name for a day's tracker and a poor name for a task,
  // and an omitted task title already makes the server fall back to the tracker
  // title — so a blank field here produces the better default, not a missing
  // one. The placeholder below shows what it will become. The mirror is not
  // seeded on purpose; it still fires normally the moment the title is typed.
  const [taskTitle, setTaskTitle] = useState(initial?.title ?? '');
  // The task title trails the tracker title only until the user makes it their
  // own — after that, typing in the tracker title must not overwrite it.
  const [taskTitleEdited, setTaskTitleEdited] = useState(false);
  const [taskStatus, setTaskStatus] = useState<TaskStatus>('in_progress');
  const [taskPriority, setTaskPriority] = useState<TaskPriority>('medium');

  // Projects grouped by their client, because project names repeat across
  // clients and the name alone is not enough to pick the right one.
  const projectGroups = projects.reduce<Array<{ clientId: string; clientName: string; projects: Project[] }>>(
    (groups, p) => {
      const group = groups.find(g => g.clientId === p.client_id);
      if (group) group.projects.push(p);
      else groups.push({ clientId: p.client_id, clientName: p.client_name, projects: [p] });
      return groups;
    },
    []
  );

  // The settings request can land after the modal is already open, so the name
  // is filled in then too — but only into a field that is still untouched and
  // still empty. Anything typed, and anything already rendered, is left exactly
  // as it is. The dependency list is deliberately just `settings`: the arrival
  // is the only event that may fill the field, and neither the start time nor
  // the title itself may re-trigger it.
  useEffect(() => {
    if (initial || titleEdited || title) return;
    const auto = autoTrackerName(settings, startTime);
    if (auto) setTitle(auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  function handleTitleChange(value: string) {
    setTitle(value);
    setTitleEdited(true);
    if (!taskTitleEdited) setTaskTitle(value);
  }

  // With the task section open there are two title fields, and filling either
  // one is enough — typing only the task title and leaving the tracker's blank
  // used to be rejected, which reads as a bug when you have plainly named the
  // thing. Whichever was typed becomes the tracker's title; the task keeps its
  // own when they differ.
  const effectiveTitle =
    title.trim() || (isCreate && createTask ? taskTitle.trim() : '');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Reported one at a time. The old combined message named the start time
    // even when only the title was missing, so a filled-in start time made the
    // error look wrong rather than pointing at the empty field.
    if (!effectiveTitle) { setErr('A title is required.'); return; }
    if (!startTime) { setErr('A start time is required.'); return; }
    // Warn rather than block — the submit button stays live (§ no locking).
    if (isCreate && createTask && !taskProjectId) {
      setErr('Choose a project for the task, or switch the task off.');
      return;
    }
    setSaving(true);
    try {
      const payload: CreateTrackerPayload = {
        title: effectiveTitle,
        start_time: toISOWithOffset(startTime),
        ...(endTime ? { end_time: toISOWithOffset(endTime) } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        // A blank task title is left out so the server applies its own default,
        // which is the tracker title — the same thing the field was showing.
        ...(isCreate && createTask
          ? {
              new_task: {
                project_id: taskProjectId,
                ...(taskTitle.trim() ? { title: taskTitle.trim() } : {}),
                status: taskStatus,
                priority: taskPriority,
              },
            }
          : {}),
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
    <Modal
      title={initial ? 'Edit Tracker' : 'New Tracker'}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" onClick={onClose} className={MODAL_CANCEL_BUTTON}>
            Cancel
          </button>
          {/* The footer is a sibling of the body inside Modal, so the button is
              tied back to the form by id. That association is also what keeps
              Enter-to-submit working: the form's default button is the first
              submit button owned by it, wherever it sits in the DOM. */}
          <button type="submit" form={FORM_ID} disabled={saving} className={MODAL_PRIMARY_BUTTON}>
            {saving ? 'Saving…' : initial ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Title</label>
          <input
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            value={title}
            onChange={e => handleTitleChange(e.target.value)}
            placeholder="Tracker title"
            autoFocus
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Start time</label>
            <DateTimeInput value={startTime} onChange={setStartTime} />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">End time (optional)</label>
            <DateTimeInput value={endTime} onChange={setEndTime} />
          </div>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Notes (optional)</label>
          <textarea
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-none"
            rows={3}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Any notes for this tracker…"
          />
        </div>

        {/* A tracker on its own has no project and no billable time. Giving it
            a task is what lets its hours reach an invoice later. */}
        {isCreate && (
          <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={createTask}
                onChange={e => setCreateTask(e.target.checked)}
                className="accent-blue-500"
              />
              Also create a task for this tracker
            </label>
            <p className="text-xs text-slate-500 -mt-2">
              The task is attached to the tracker, and the notes above become its description.
            </p>

            {createTask && (
              <>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Project</label>
                  <select
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                    value={taskProjectId}
                    onChange={e => setTaskProjectId(e.target.value)}
                  >
                    <option value="">Select a project…</option>
                    {projectGroups.map(g => (
                      <optgroup key={g.clientId} label={g.clientName}>
                        {g.projects.map(p => (
                          <option key={p.id} value={p.id}>{g.clientName} / {p.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Task title</label>
                  <input
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                    value={taskTitle}
                    onChange={e => { setTaskTitle(e.target.value); setTaskTitleEdited(true); }}
                    placeholder={title.trim() || 'Same as the tracker title'}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Status</label>
                    <select
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                      value={taskStatus}
                      onChange={e => setTaskStatus(e.target.value as TaskStatus)}
                    >
                      {TASK_STATUSES.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Priority</label>
                    <select
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                      value={taskPriority}
                      onChange={e => setTaskPriority(e.target.value as TaskPriority)}
                    >
                      {TASK_PRIORITIES.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {err && <p className="text-xs text-red-400">{err}</p>}
      </form>
    </Modal>
  );
}

// ── Add Tasks Modal ───────────────────────────────────────────────────────────

interface AddTasksModalProps {
  tracker: Tracker;
  allTasks: Task[];
  clients: Client[];
  projects: Project[];
  onAdd: (taskIds: string[]) => Promise<void>;
  // Create the pasted titles as new tasks under a project and link them to the
  // tracker. The page owns both calls so its task list stays in step.
  onCreateTasks: (projectId: string, titles: string[]) => Promise<void>;
  onClose: () => void;
}

type AddTasksMode = 'pick' | 'paste';

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

function AddTasksModal({ tracker, allTasks, clients, projects, onAdd, onCreateTasks, onClose }: AddTasksModalProps) {
  const existingIds = new Set(tracker.tasks.map(t => t.task_id));

  const [mode, setMode] = useState<AddTasksMode>('pick');
  const [expandedClients, setExpandedClients] = useState<Set<string>>(
    () => new Set(clients.map(c => c.id))
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Paste mode: the textarea is the source, `titles` the editable result of
  // parsing it. The splitter can guess wrong, so every title stays editable.
  const [pasteProjectId, setPasteProjectId] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [titles, setTitles] = useState<string[]>([]);
  const filledTitles = titles.map(t => t.trim()).filter(Boolean);

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

  function handlePasteChange(text: string) {
    setPasteText(text);
    setTitles(parseTaskList(text));
  }

  function updateTitle(index: number, value: string) {
    setTitles(prev => prev.map((t, i) => (i === index ? value : t)));
  }

  function removeTitle(index: number) {
    setTitles(prev => prev.filter((_, i) => i !== index));
  }

  async function handleAdd() {
    if (selected.size === 0) return;
    setSaving(true);
    setErr('');
    try {
      await onAdd(Array.from(selected));
      onClose();
    } catch (e) {
      setErr(errorDetail(e, 'Failed to add the tasks. Please try again.'));
    } finally {
      setSaving(false);
    }
  }

  // Both calls have to land — created tasks that never reached the tracker
  // would be invisible here — so the modal stays open on any failure.
  async function handleCreate() {
    if (!pasteProjectId || filledTitles.length === 0) return;
    setSaving(true);
    setErr('');
    try {
      await onCreateTasks(pasteProjectId, filledTitles);
      onClose();
    } catch (e) {
      setErr(errorDetail(e, 'Failed to create the tasks. Please try again.'));
    } finally {
      setSaving(false);
    }
  }

  // The body is a column of tabs plus a pane region that owns its own scrolling,
  // so it drops the modal's default padding and gap and never scrolls itself.
  return (
    <Modal
      title="Add tasks to tracker"
      onClose={onClose}
      size="md"
      maxHeight="80vh"
      bodyClassName="flex flex-col overflow-hidden p-0"
      footer={
        <>
          {/* The error takes the status line's slot rather than adding a row,
              so the footer keeps its height either way. */}
          {err ? (
            <span className="text-xs text-red-400">{err}</span>
          ) : mode === 'pick' ? (
            <span className="text-xs text-slate-400">
              {selected.size > 0 ? `${selected.size} task${selected.size !== 1 ? 's' : ''} selected` : 'Click tasks to select'}
            </span>
          ) : (
            <span className="text-xs text-slate-400">
              {filledTitles.length > 0
                ? `${filledTitles.length} task${filledTitles.length !== 1 ? 's' : ''} ready`
                : 'Paste something to get started'}
            </span>
          )}
          <div className="flex gap-2 shrink-0">
            <button onClick={onClose} className={MODAL_CANCEL_BUTTON}>
              Cancel
            </button>
            {mode === 'pick' ? (
              <button
                onClick={handleAdd}
                disabled={saving || selected.size === 0}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
              >
                {saving ? 'Adding…' : `Add${selected.size > 0 ? ` (${selected.size})` : ''}`}
              </button>
            ) : (
              <button
                onClick={handleCreate}
                disabled={saving || !pasteProjectId || filledTitles.length === 0}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
              >
                {saving ? 'Creating…' : `Create${filledTitles.length > 0 ? ` (${filledTitles.length})` : ''}`}
              </button>
            )}
          </div>
        </>
      }
    >
      {/* Mode tabs */}
      <div className="flex gap-1 px-5 pt-3 pb-2 border-b border-slate-800 shrink-0">
        {([['pick', 'Pick existing'], ['paste', 'Paste new tasks']] as const).map(([value, label]) => (
          <button
            key={value}
            onClick={() => { setMode(value); setErr(''); }}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
              mode === value
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'pick' ? (
      /* Body: sidebar + task tree */
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
      ) : (
      /* Body: paste a block of text, review it, create the tasks */
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Project</label>
          <select
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            value={pasteProjectId}
            onChange={e => setPasteProjectId(e.target.value)}
          >
            <option value="">Select a project…</option>
            {clientProjectGroups.map(({ client, projects: cProjects }) => (
              cProjects.length > 0 && (
                <optgroup key={client.id} label={client.name}>
                  {cProjects.map(p => (
                    <option key={p.id} value={p.id}>{client.name} / {p.name}</option>
                  ))}
                </optgroup>
              )
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Paste your tasks</label>
          <textarea
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-none"
            rows={5}
            value={pasteText}
            onChange={e => handlePasteChange(e.target.value)}
            placeholder="One per line, or a paragraph — each sentence becomes a task."
          />
        </div>

        {titles.length === 0 ? (
          <p className="text-xs text-slate-500">
            Nothing parsed yet. Everything below stays editable before you create it.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Preview
              </span>
              <span className="text-xs text-slate-500">
                {filledTitles.length} task{filledTitles.length !== 1 ? 's' : ''}
              </span>
            </div>
            {titles.map((title, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-xs text-slate-600 text-right">{i + 1}</span>
                <input
                  className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                  value={title}
                  onChange={e => updateTitle(i, e.target.value)}
                />
                <button
                  onClick={() => removeTitle(i)}
                  className="shrink-0 text-slate-600 hover:text-red-400 transition-colors"
                  title="Remove this task"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
            <p className="text-xs text-slate-500">
              Blank titles are dropped. The tasks are created in the project above and linked to this tracker.
            </p>
          </div>
        )}
      </div>
      )}
    </Modal>
  );
}

// ── Tracker Panel (right-side detail) ────────────────────────────────────────

interface TrackerPanelProps {
  tracker: Tracker;
  onEdit: () => void;
  onDelete: () => void;
  onStop: () => void;
  onAddTasks: () => void;
  // Awaited by the confirmation, so a failed removal keeps the dialog open and
  // shows why instead of leaving the row in place with no explanation.
  onRemoveTask: (taskId: string) => Promise<void>;
  // Billing is the only action on this page that writes to the `sessions`
  // collection, which is the sole source of the weekly summary's figures. The
  // panel owns the billing form, so the page cannot see the write happen — this
  // is how it hears about it. Fire-and-forget: the billing result is already
  // shown here and must not depend on whatever the page does next.
  onBilled: () => void;
}

function TrackerPanel({ tracker, onEdit, onDelete, onStop, onAddTasks, onRemoveTask, onBilled }: TrackerPanelProps) {
  const isActive = !tracker.end_time;
  const navigate = useNavigate();

  // One dialog for the whole list — the row being removed is the state, so the
  // tracker's tasks do not each carry a dialog of their own.
  const [removeTarget, setRemoveTarget] = useState<TrackerTaskRef | null>(null);

  // Billing the tracker: turning its span into time entries on the `sessions`
  // collection, which is what an invoice reads.
  const [billOpen, setBillOpen] = useState(false);
  const [billSplit, setBillSplit] = useState<'even' | 'full'>('even');
  const [billHours, setBillHours] = useState('');
  const [billable, setBillable] = useState(true);
  const [billing, setBilling] = useState(false);
  const [billErr, setBillErr] = useState('');
  const [billCount, setBillCount] = useState<number | null>(null);
  const [billedTaskIds, setBilledTaskIds] = useState<string[]>([]);

  // The server bills only the tasks it has not already billed from this tracker,
  // so hours entered on a second pass land entirely on the newcomers. Knowing
  // which tasks are already covered is what lets us warn about that.
  const alreadyBilled = tracker.tasks.filter(t => billedTaskIds.includes(t.task_id)).length;
  const remaining = tracker.tasks.length - alreadyBilled;

  // Best-effort: a failed lookup costs the warning, never the billing.
  function refreshBilledTasks() {
    getSessions({ tracker_id: tracker.id })
      .then(entries => setBilledTaskIds(entries.map(s => s.task_id)))
      .catch(() => setBilledTaskIds([]));
  }

  function openBilling() {
    const elapsed = elapsedHours(tracker);
    // The tracker's own span is only the starting number — it stays editable,
    // and is never quietly reduced to a share. The warning tells; it decides.
    setBillHours(elapsed !== null ? elapsed.toFixed(2) : '');
    setBillSplit('even');
    setBillable(true);
    setBillErr('');
    setBillCount(null);
    setBilledTaskIds([]);
    setBillOpen(true);
    refreshBilledTasks();
  }

  async function handleBill(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = billHours.trim();
    const hours = trimmed ? Number(trimmed) : undefined;
    if (hours !== undefined && !Number.isFinite(hours)) {
      setBillErr('Hours must be a number.');
      return;
    }
    setBilling(true);
    setBillErr('');
    setBillCount(null);
    try {
      const created = await billTracker(tracker.id, {
        split: billSplit,
        ...(hours !== undefined ? { hours } : {}),
        billable,
      });
      setBillCount(created.length);
      // The panel stays open, so the warning has to reflect what was just billed.
      refreshBilledTasks();
      // New time entries exist, so the weekly summary is stale from this moment
      // on — even if the user is looking at this panel and not at that tab.
      onBilled();
    } catch (e) {
      setBillErr(errorDetail(e, 'Failed to create time entries. Please try again.'));
    } finally {
      setBilling(false);
    }
  }

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
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Tasks ({tracker.tasks.length})
            </h3>
            <div className="flex items-center gap-3 shrink-0">
              <button
                onClick={onAddTasks}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                + Add tasks
              </button>
              <button
                onClick={() => (billOpen ? setBillOpen(false) : openBilling())}
                disabled={tracker.tasks.length === 0}
                className="px-2.5 py-1 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
              >
                Create time entries
              </button>
            </div>
          </div>

          {/* Billing panel — the bridge from tracked time to billable hours */}
          {billOpen && (
            <form
              onSubmit={handleBill}
              className="flex flex-col gap-3 mb-4 p-4 rounded-lg bg-slate-900 border border-slate-700"
            >
              <div>
                <span className="block text-xs text-slate-400 mb-1.5">How should the hours land?</span>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                    <input
                      type="radio"
                      name="split"
                      checked={billSplit === 'even'}
                      onChange={() => setBillSplit('even')}
                      className="accent-blue-500"
                    />
                    Divide across tasks
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                    <input
                      type="radio"
                      name="split"
                      checked={billSplit === 'full'}
                      onChange={() => setBillSplit('full')}
                      className="accent-blue-500"
                    />
                    Full span for each task
                  </label>
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  Divide = the tracker's hours shared out; full = each task billed the whole span, for work done in parallel.
                </p>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Hours</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="w-32 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  value={billHours}
                  onChange={e => setBillHours(e.target.value)}
                  placeholder="0.00"
                />
                <p className="mt-1 text-xs text-slate-500">
                  {isActive
                    ? 'This tracker is still running, so enter the hours yourself — the server needs a number.'
                    : "Prefilled from the tracker's span. Change it freely."}
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={billable}
                  onChange={e => setBillable(e.target.checked)}
                  className="accent-blue-500"
                />
                Billable
              </label>

              {alreadyBilled > 0 && (
                <p className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
                  {remaining === 0 ? (
                    'Every task on this tracker already has a time entry from it. Submitting creates nothing new — add a task first, or edit the existing entries on the Time Entries page.'
                  ) : (
                    <>
                      {alreadyBilled} of {tracker.tasks.length} task{tracker.tasks.length !== 1 ? 's' : ''}
                      {alreadyBilled === 1 ? ' already has a time entry' : ' already have time entries'}.{' '}
                      {remaining === 1
                        ? 'The hours you enter will go entirely to the 1 remaining task — set them to just that task’s share.'
                        : billSplit === 'even'
                        ? `The hours you enter will be split across only the ${remaining} remaining tasks — set them to just those tasks’ share.`
                        : `Each of the ${remaining} remaining tasks will be billed the full hours you enter — set them to just that share.`}
                    </>
                  )}
                </p>
              )}

              {billErr && <p className="text-xs text-red-400">{billErr}</p>}

              {billCount !== null && (
                billCount > 0 ? (
                  <p className="text-xs text-green-400">
                    Created {billCount} time {billCount === 1 ? 'entry' : 'entries'}.{' '}
                    <Link to="/time" className="text-blue-400 hover:text-blue-300 underline transition-colors">
                      Time Entries
                    </Link>
                  </p>
                ) : (
                  <p className="text-xs text-slate-400">
                    Every task on this tracker already has a time entry. Nothing new was created.
                  </p>
                )
              )}

              <div className="flex items-center justify-between gap-3 pt-1">
                <p className="text-xs text-slate-500">
                  A starting point — hours, dates and rates stay editable on the Time Entries page.
                </p>
                <button
                  type="submit"
                  disabled={billing}
                  className="shrink-0 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
                >
                  {billing ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          )}
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
                    onClick={() => setRemoveTarget(t)}
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

      {removeTarget && (
        <ConfirmDialog
          open
          title="Remove task"
          message={<>Remove “{removeTarget.task_title}” from this tracker?</>}
          detail="The task itself is not deleted — only its link to this tracker."
          confirmLabel="Remove"
          onConfirm={() => onRemoveTask(removeTarget.task_id)}
          onClose={() => setRemoveTarget(null)}
          errorFallback="Failed to remove the task. Please try again."
        />
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type ModalState =
  | { kind: 'none' }
  | { kind: 'create_tracker' }
  | { kind: 'edit_tracker'; tracker: Tracker }
  | { kind: 'add_tasks'; tracker: Tracker };

// The page-level tabs. `trackers` is the two-column body this page has always
// been; `weekly` swaps that body out for the summary.
const PAGE_TABS = [
  ['trackers', 'Trackers'],
  ['weekly', 'Weekly summary'],
] as const;

type PageTab = (typeof PAGE_TABS)[number][0];

export default function TrackersPage() {
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [trackerSettings, setTrackerSettings] = useState<TrackerSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [tab, setTab] = useState<PageTab>('trackers');

  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'done'>('all');

  const [selectedTracker, setSelectedTracker] = useState<Tracker | null>(null);

  const [modal, setModal] = useState<ModalState>({ kind: 'none' });

  // Kept apart from `modal` so the confirmation can sit above whatever else is
  // open, and so the tracker being deleted survives the panel's own state.
  const [deleteTarget, setDeleteTarget] = useState<Tracker | null>(null);

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
      // Kept out of the Promise.all: the naming template is a convenience, and
      // losing it must not cost the page its trackers or block creating one.
      try {
        setTrackerSettings(await getTrackerSettings());
      } catch {
        setTrackerSettings(null);   // no pre-filled name, no error shown
      }
    } catch {
      setError('Failed to load data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Weekly summary data ──
  //
  // Kept entirely apart from `loading`/`error` above, which belong to the
  // tracker list: a failed time-entry fetch must not blank the Trackers tab,
  // and a failed tracker fetch must not be reported as a broken summary.

  const [weekCount, setWeekCount] = useState(12);
  const [weeklySessions, setWeeklySessions] = useState<Session[]>([]);
  const [invoiceSettings, setInvoiceSettings] = useState<InvoiceSettings | null>(null);
  // Read for one field only: `line.tracker_id`. A tracker can be billed
  // straight onto an invoice line with no time entry in between, and without
  // this list every such tracker reports its whole span as still owed.
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [weeklyError, setWeeklyError] = useState('');
  // Non-fatal: the rates fell back a level, but every figure still renders.
  const [rateNote, setRateNote] = useState('');

  // Bumped only by billing, which is the one action on this page that writes
  // time entries. Not read by the fetcher — it exists purely as an invalidation
  // signal in the effect's dependency list, which is the cheapest honest way to
  // say "the answer you have is out of date" without threading a refetch
  // through the panel that caused it. See the note above the tracker actions
  // for why nothing else bumps it.
  const [weeklyStamp, setWeeklyStamp] = useState(0);
  const bumpWeekly = useCallback(() => setWeeklyStamp(n => n + 1), []);

  // Lazy: only ever set, never cleared, so the fetch happens the first time the
  // Weekly tab is opened and the Trackers tab costs exactly what it did before
  // this tab existed. Switching back and forth afterwards costs nothing either
  // — the effect below re-runs on `weekCount` and `weeklyStamp`, not on `tab`.
  const [weeklyOpened, setWeeklyOpened] = useState(false);
  useEffect(() => {
    if (tab === 'weekly') setWeeklyOpened(true);
  }, [tab]);

  // Newest Monday first. Recomputed only when the window size changes, so it is
  // a stable dependency for the fetcher and the summary below.
  const weekStarts = useMemo(() => recentWeekStarts(weekCount), [weekCount]);

  const fetchWeekly = useCallback(async () => {
    // The window's first day is the OLDEST Monday, which is the LAST element —
    // `recentWeekStarts` hands them back newest first.
    const from = weekStarts[weekStarts.length - 1];
    if (!from) return;

    setWeeklyLoading(true);
    setWeeklyError('');
    setRateNote('');
    try {
      // Deliberately unfiltered — no `date_from`, no `date_to`.
      //
      // `date_to` was always wrong: an entry dated into the future still
      // belongs to the week it is dated to, and capping at today would drop it
      // silently rather than show it in a week that is simply ahead of now.
      //
      // `date_from` became wrong when the summary started counting trackers.
      // `summariseWeeks` decides how much of a tracker is still unbilled by
      // finding its id across *every* entry; narrowing the list to the window
      // hides an entry dated before it, and the tracker then reappears as
      // phantom hours that were billed months ago. `mobile/app/trackers.tsx`
      // has fetched the whole list for this reason from the start.
      //
      // `from` is still read above: it guards against an empty window.
      setWeeklySessions(await getSessions());
    } catch {
      setWeeklySessions([]);
      setWeeklyError('Failed to load time entries.');
      setWeeklyLoading(false);
      return;
    }

    // Not fatal, and not silent either. Losing this list does not change the
    // hours — it changes which of them are called "not billed yet", and a
    // tracker already invoiced would be reported as still owing.
    try {
      setInvoices(await getInvoices());
    } catch {
      setInvoices([]);
      setRateNote(
        'Invoices could not be loaded, so tracker time already billed straight onto an invoice is counted as not billed yet. The hours are unaffected.'
      );
    }

    // Invoice settings are the last link in the rate chain (project → client →
    // settings), so losing them is not the harmless miss that a failed
    // `getTrackerSettings()` is — that one costs a pre-filled name, this one
    // silently changes money. It is fetched outside the block above so it can
    // neither fail the tab nor be swallowed: the summary still renders with
    // `settings: null`, every rate that would have come from settings falls
    // back, and the note says so out loud.
    try {
      setInvoiceSettings(await getInvoiceSettings());
    } catch {
      setInvoiceSettings(null);
      setRateNote(
        'Invoice settings could not be loaded, so any rate that falls back to them reads as “No rate set”. The hours are unaffected.'
      );
    } finally {
      setWeeklyLoading(false);
    }
  }, [weekStarts]);

  useEffect(() => {
    if (!weeklyOpened) return;
    fetchWeekly();
    // `weeklyStamp` is not read inside `fetchWeekly`; it is the invalidation
    // signal described above. `fetchWeekly` itself changes with `weekCount`,
    // which is what makes resizing the window refetch.
  }, [weeklyOpened, fetchWeekly, weeklyStamp]);

  // All the arithmetic lives in `summariseWeeks`. `trackers`, `tasks`,
  // `projects` and `clients` are the page's own state, already loaded by
  // `fetchData` — the summary reuses them rather than fetching a second copy,
  // which also means a tracker created, edited, stopped or deleted is reflected
  // here the moment the list updates, with no request at all.
  //
  // `tasks` is load-bearing, not incidental: a tracker has no `project_id`, so
  // the only way its unbilled hours reach a rate is `TrackerTaskRef.task_id` →
  // `Task.project_id` — the same hop `bill_tracker` makes on the server. Drop
  // it and every tracker hour falls into `trackers.unpriced_hours` and shows up
  // in the hours with no money against it.
  const weeks = useMemo(
    () => summariseWeeks({
      sessions: weeklySessions,
      trackers,
      projects,
      clients,
      tasks,
      invoices,
      settings: invoiceSettings,
      weekStarts,
    }),
    [weeklySessions, trackers, projects, clients, tasks, invoices, invoiceSettings, weekStarts]
  );

  function openTracker(t: Tracker) {
    setSelectedTracker(t);
  }

  const filteredTrackers = trackers.filter(t => {
    if (filterActive === 'active') return !t.end_time;
    if (filterActive === 'done') return !!t.end_time;
    return true;
  });

  // ── Tracker actions ──
  //
  // Only billing invalidates the weekly summary, and it does so through
  // `onBilled` on the panel below — it is the one action here that writes to
  // the `sessions` collection, which the page has no other way to observe.
  //
  // Creating, editing, stopping and deleting a tracker deliberately do NOT
  // refetch. Each of them writes the server's own answer straight into
  // `trackers`, and `trackers` is a dependency of the `weeks` memo, so the
  // summary already follows them instantly and with no request. Bumping here as
  // well would cost a full scan of the time entries to arrive at the figures
  // the memo has produced already. `delete_tracker` does not cascade to
  // sessions (back/routers/trackers.py), so even a delete cannot change them.

  async function handleCreateTracker(payload: CreateTrackerPayload) {
    const created = await createTracker(payload);
    setTrackers(prev => [created, ...prev]);
    // The server made a task we have never seen; refetch so the "Pick existing"
    // tree and the rest of the page know about it.
    if (payload.new_task) {
      try {
        setTasks(await getTasks());
      } catch {
        // The tracker is created either way — a stale task list is not worth
        // failing the save for.
      }
    }
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

  // No try/catch: a failure has to reach the confirmation, which keeps itself
  // open and says what went wrong rather than dropping the row from the list.
  async function handleDeleteTracker(tracker: Tracker) {
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

  // Pasted titles become real tasks, which are then linked to the tracker. The
  // new tasks are merged into `tasks` so the "Pick existing" tree isn't stale.
  async function handleCreateTasks(projectId: string, titles: string[]) {
    if (!selectedTracker) return;
    const created = await createTasksBulk({ project_id: projectId, titles });
    setTasks(prev => [...created, ...prev]);
    const updated = await addTasksToTracker(selectedTracker.id, created.map(t => t.id));
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
      <AppNav active="trackers" wide />

      {/* ── Page tabs ──
          Its own `shrink-0` row: the page is a fixed-height column, so the
          strip must take its natural height and leave the body below to be the
          only thing that flexes. */}
      <div className="flex gap-1 px-4 py-2 border-b border-slate-800 shrink-0">
        {PAGE_TABS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => {
              setTab(value);
              // A modal opened from the tracker body has no meaning once that
              // body is unmounted, and leaving the state set would spring it
              // back open on the way here. Closing beats hiding.
              if (value !== 'trackers') {
                setModal({ kind: 'none' });
                setDeleteTarget(null);
              }
            }}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
              tab === value
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'weekly' ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Non-fatal, and page-owned rather than passed to the pane: the pane's
              `error` is the fatal channel that replaces the summary with a retry,
              and a fallen-back rate must not blank figures that are still true. */}
          {rateNote && (
            <div className="px-4 py-2 text-xs text-amber-300 bg-amber-400/10 border-b border-amber-400/20 shrink-0">
              {rateNote}
            </div>
          )}
          <WeeklySummaryPane
            weeks={weeks}
            weekCount={weekCount}
            onChangeWeekCount={setWeekCount}
            loading={weeklyLoading}
            error={weeklyError}
            onRetry={fetchWeekly}
          />
        </div>
      ) : (

      /* ── Body: two-column layout ── */
      <div className="flex flex-1 overflow-hidden">
      {/* ── Left column: tracker list ── */}
      <div className="flex flex-col w-96 border-r border-slate-800 shrink-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <span className="text-sm font-semibold text-white">Trackers</span>
          <div className="flex items-center gap-2">
            <Link
              to="/trackers/settings"
              className="px-2.5 py-1.5 text-xs rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            >
              Settings
            </Link>
            <button
              onClick={() => setModal({ kind: 'create_tracker' })}
              className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
            >
              + New
            </button>
          </div>
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
            key={selectedTracker.id}
            tracker={selectedTracker}
            onEdit={() => setModal({ kind: 'edit_tracker', tracker: selectedTracker })}
            onDelete={() => setDeleteTarget(selectedTracker)}
            onStop={() => handleStopTracker(selectedTracker)}
            onAddTasks={() => setModal({ kind: 'add_tasks', tracker: selectedTracker })}
            onRemoveTask={handleRemoveTask}
            onBilled={bumpWeekly}
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
          projects={projects}
          settings={trackerSettings}
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
          onCreateTasks={handleCreateTasks}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          open
          title="Delete tracker"
          message={<>Delete tracker “{deleteTarget.title}”?</>}
          onConfirm={() => handleDeleteTracker(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
          errorFallback="Failed to delete the tracker. Please try again."
        />
      )}
      </div>

      )}
    </div>
  );
}
