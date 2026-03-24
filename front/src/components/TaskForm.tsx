import { useState, useRef, useEffect } from 'react';
import type { Task, Project, TaskStatus, TaskPriority, CreateTaskPayload } from '../types';
import { getTasks } from '../api';

interface Props {
  projects: Project[];
  initialValues?: Partial<Task>;
  defaultProjectId?: string;
  defaultParentTaskId?: string;
  onSubmit: (data: CreateTaskPayload & { files: File[] }) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

const STATUS_OPTIONS: { value: TaskStatus; label: string; color: string }[] = [
  { value: 'todo', label: 'Todo', color: 'text-slate-400' },
  { value: 'in_progress', label: 'In Progress', color: 'text-blue-400' },
  { value: 'done', label: 'Done', color: 'text-green-400' },
];

const PRIORITY_OPTIONS: { value: TaskPriority; label: string; color: string; dot: string }[] = [
  { value: 'low', label: 'Low', color: 'text-slate-400', dot: 'bg-slate-400' },
  { value: 'medium', label: 'Medium', color: 'text-blue-400', dot: 'bg-blue-400' },
  { value: 'high', label: 'High', color: 'text-orange-400', dot: 'bg-orange-400' },
  { value: 'urgent', label: 'Urgent', color: 'text-red-400', dot: 'bg-red-400' },
];

export default function TaskForm({
  projects,
  initialValues,
  defaultProjectId,
  defaultParentTaskId,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
}: Props) {
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [description, setDescription] = useState(initialValues?.description ?? '');
  const [projectId, setProjectId] = useState(
    initialValues?.project_id ?? defaultProjectId ?? projects[0]?.id ?? ''
  );
  const [parentTaskId, setParentTaskId] = useState<string>(
    initialValues?.parent_task_id ?? defaultParentTaskId ?? ''
  );
  const [status, setStatus] = useState<TaskStatus>(initialValues?.status ?? 'todo');
  const [priority, setPriority] = useState<TaskPriority>(initialValues?.priority ?? 'medium');
  const [dueDate, setDueDate] = useState(initialValues?.due_date ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [parentTasks, setParentTasks] = useState<Task[]>([]);
  const [loadingParents, setLoadingParents] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load potential parent tasks when project changes
  useEffect(() => {
    if (!projectId) {
      setParentTasks([]);
      return;
    }
    setLoadingParents(true);
    getTasks({ project_id: projectId })
      .then((tasks) => {
        // Exclude the current task itself from parent options
        const filtered = tasks.filter(
          (t) => !initialValues?.id || t.id !== initialValues.id
        );
        setParentTasks(filtered);
      })
      .catch(() => setParentTasks([]))
      .finally(() => setLoadingParents(false));
  }, [projectId, initialValues?.id]);

  // Reset parent task if project changes
  const handleProjectChange = (id: string) => {
    setProjectId(id);
    setParentTaskId('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!title.trim()) {
      setError('Title cannot be empty.');
      return;
    }
    if (!projectId) {
      setError('Please select a project.');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        project_id: projectId,
        parent_task_id: parentTaskId || undefined,
        status,
        priority,
        due_date: dueDate || undefined,
        files,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Group projects by client
  const clientGroups = projects.reduce<Record<string, { clientName: string; projects: Project[] }>>(
    (acc, p) => {
      if (!acc[p.client_id]) {
        acc[p.client_id] = { clientName: p.client_name, projects: [] };
      }
      acc[p.client_id].projects.push(p);
      return acc;
    },
    {}
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">
          Title <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={submitting}
          placeholder="What needs to be done?"
          className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                     placeholder:text-slate-500
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                     disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>

      {/* Project */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">
          Project <span className="text-red-400">*</span>
        </label>
        <select
          value={projectId}
          onChange={(e) => handleProjectChange(e.target.value)}
          disabled={submitting}
          className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="">Select a project…</option>
          {Object.values(clientGroups).map((group) => (
            <optgroup key={group.clientName} label={group.clientName}>
              {group.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {group.clientName} / {p.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Parent task */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">
          Make subtask of…{' '}
          <span className="text-slate-500 font-normal">(optional)</span>
        </label>
        <select
          value={parentTaskId}
          onChange={(e) => setParentTaskId(e.target.value)}
          disabled={submitting || !projectId || loadingParents}
          className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="">None (top-level task)</option>
          {parentTasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        {!projectId && (
          <p className="text-xs text-slate-500">Select a project first.</p>
        )}
      </div>

      {/* Description */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">
          Description{' '}
          <span className="text-slate-500 font-normal">(optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={submitting}
          rows={4}
          placeholder="Add details, context, or acceptance criteria…"
          className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                     placeholder:text-slate-500 resize-y
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                     disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>

      {/* Status + Priority row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Status */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-300">Status</label>
          <div className="flex flex-col gap-1">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setStatus(opt.value)}
                disabled={submitting}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors
                  ${status === opt.value
                    ? 'bg-slate-700 border-slate-600 text-slate-100'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-750 hover:border-slate-600'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  opt.value === 'todo' ? 'bg-slate-400' :
                  opt.value === 'in_progress' ? 'bg-blue-400' : 'bg-green-400'
                }`} />
                <span className={status === opt.value ? 'text-slate-100' : opt.color}>
                  {opt.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Priority */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-300">Priority</label>
          <div className="flex flex-col gap-1">
            {PRIORITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPriority(opt.value)}
                disabled={submitting}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors
                  ${priority === opt.value
                    ? 'bg-slate-700 border-slate-600 text-slate-100'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-750 hover:border-slate-600'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${opt.dot}`} />
                <span className={priority === opt.value ? 'text-slate-100' : opt.color}>
                  {opt.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Due date */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">
          Due Date{' '}
          <span className="text-slate-500 font-normal">(optional)</span>
        </label>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          disabled={submitting}
          className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                     disabled:opacity-50 disabled:cursor-not-allowed
                     [color-scheme:dark]"
        />
      </div>

      {/* Attachments */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">Attachments</label>
        <div
          className="border-2 border-dashed border-slate-700 rounded-lg p-4 cursor-pointer
                     hover:border-violet-500/60 transition-colors"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const dropped = Array.from(e.dataTransfer.files);
            setFiles((prev) => [...prev, ...dropped]);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />
          <div className="flex flex-col items-center gap-1 text-center">
            <svg
              className="w-8 h-8 text-slate-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
              />
            </svg>
            <p className="text-sm text-slate-400">
              <span className="text-violet-400 font-medium">Click to upload</span> or drag & drop
            </p>
            <p className="text-xs text-slate-500">Any file type</p>
          </div>
        </div>

        {files.length > 0 && (
          <ul className="flex flex-col gap-1 mt-1">
            {files.map((f, i) => (
              <li
                key={i}
                className="flex items-center justify-between bg-slate-800 rounded-lg px-3 py-1.5 text-xs"
              >
                <span className="text-slate-300 truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  className="text-slate-500 hover:text-red-400 transition-colors ml-2 shrink-0"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-800 border border-slate-700
                     rounded-lg hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-5 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg
                     hover:bg-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-2"
        >
          {submitting && (
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          )}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
