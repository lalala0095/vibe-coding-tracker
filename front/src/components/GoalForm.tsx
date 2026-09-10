import { useState, useRef } from 'react';
import type { Model, Goal, Task } from '../types';
import ModelSelector from './ModelSelector';

interface Props {
  models: Model[];
  tasks?: Task[];
  defaultTaskId?: string;
  initialValues?: Partial<Goal>;
  onSubmit: (data: { model_id: string; goal: string; output: string; task_id?: string; files: File[] }) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

export default function GoalForm({
  models,
  tasks = [],
  defaultTaskId,
  initialValues,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
}: Props) {
  const [modelId, setModelId] = useState(initialValues?.model_id ?? models[0]?.id ?? '');
  const [taskId, setTaskId] = useState(initialValues?.task_id ?? defaultTaskId ?? '');
  const [goal, setGoal] = useState(initialValues?.goal ?? '');
  const [output, setOutput] = useState(initialValues?.output ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!modelId) {
      setError('Please select a model.');
      return;
    }
    if (!goal.trim()) {
      setError('Goal / prompt cannot be empty.');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({ model_id: modelId, goal: goal.trim(), output: output.trim(), task_id: taskId || undefined, files });
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

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Model */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">
          AI Model <span className="text-red-400">*</span>
        </label>
        <ModelSelector
          models={models}
          value={modelId}
          onChange={setModelId}
          disabled={submitting}
        />
      </div>

      {/* Linked Task (optional) */}
      {tasks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-300">
            Linked Task{' '}
            <span className="text-slate-500 font-normal">(optional)</span>
          </label>
          <select
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            disabled={submitting}
            className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">None</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.client_name} / {t.project_name} / {t.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Goal / Prompt */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">
          Goal / Prompt <span className="text-red-400">*</span>
        </label>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={submitting}
          rows={5}
          placeholder="Describe what you asked the AI to do…"
          className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                     placeholder:text-slate-500 resize-y
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                     disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>

      {/* Output */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">AI Output</label>
        <textarea
          value={output}
          onChange={(e) => setOutput(e.target.value)}
          disabled={submitting}
          rows={7}
          placeholder="Paste the AI's response here…"
          className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                     placeholder:text-slate-500 resize-y font-mono
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                     disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>

      {/* Attachments */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-300">Attachments</label>
        <div
          className="border-2 border-dashed border-slate-700 rounded-lg p-4 cursor-pointer
                     hover:border-violet-500/60 transition-colors"
          onClick={() => fileInputRef.current?.click()}
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

        {/* Selected files list */}
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
