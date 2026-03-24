import { useState, useEffect } from 'react';
import type { Goal, Model } from '../types';
import { deleteGoal, updateGoal } from '../api';
import GoalForm from './GoalForm';

interface Props {
  goal: Goal;
  models: Model[];
  onClose: () => void;
  onUpdated: (goal: Goal) => void;
  onDeleted: (id: string) => void;
}

function formatDatetime(iso: string): string {
  return new Date(iso).toLocaleString('en-SG', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'Asia/Singapore',
  });
}

export default function GoalPanel({ goal, models, onClose, onUpdated, onDeleted }: Props) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset to view mode when goal changes
  useEffect(() => {
    setMode('view');
    setConfirmDelete(false);
  }, [goal.id]);

  const handleUpdate = async (data: {
    model_id: string;
    goal: string;
    output: string;
    task_id?: string;
    files: File[];
  }) => {
    const updated = await updateGoal(goal.id, data, data.files);
    onUpdated(updated);
    setMode('view');
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteGoal(goal.id);
      onDeleted(goal.id);
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (mode === 'edit') {
    return (
      <aside className="w-1/2 shrink-0 border-l border-slate-800 bg-slate-900 flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
          <span className="text-sm font-semibold text-slate-100">Edit Session</span>
          <button
            onClick={() => setMode('view')}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors px-2 py-1 hover:bg-slate-800 rounded-lg"
          >
            Cancel
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <GoalForm
            models={models}
            initialValues={goal}
            onSubmit={handleUpdate}
            onCancel={() => setMode('view')}
            submitLabel="Save Changes"
          />
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-1/2 shrink-0 border-l border-slate-800 bg-slate-900 flex flex-col h-full overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800 shrink-0 min-h-[52px]">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                       bg-violet-500/15 text-violet-300 border border-violet-500/25 shrink-0"
          >
            {goal.model_name}
          </span>
          <span className="text-xs text-slate-400 truncate">{formatDatetime(goal.datetime_inserted)}</span>
        </div>
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

      {/* Panel body */}
      <div className="flex flex-col h-full overflow-hidden">
        {/* Action bar */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-800 shrink-0">
          <button
            onClick={() => setMode('edit')}
            className="px-2.5 py-1 text-xs font-medium text-slate-300 bg-slate-800 border border-slate-700
                       rounded-lg hover:bg-slate-700 transition-colors"
          >
            Edit
          </button>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="px-2.5 py-1 text-xs font-medium text-red-400 bg-red-400/10 border border-red-400/20
                         rounded-lg hover:bg-red-400/20 transition-colors"
            >
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400">Delete?</span>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 rounded-lg
                           hover:bg-red-500 disabled:opacity-50 flex items-center gap-1"
              >
                {deleting && <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                Yes
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
              >
                No
              </button>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-5 p-5">
          {/* Goal / Prompt */}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Goal / Prompt</p>
            <p className="text-sm text-slate-100 leading-relaxed whitespace-pre-wrap bg-slate-800/50 rounded-lg p-3">
              {goal.goal}
            </p>
          </div>

          {/* AI Output */}
          {goal.output && (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">AI Output</p>
              <pre
                className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-sm
                           text-slate-300 font-mono leading-relaxed whitespace-pre-wrap
                           overflow-x-auto"
              >
                {goal.output}
              </pre>
            </div>
          )}

          {/* Linked Task */}
          {goal.task_title && (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Linked Task</p>
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/50 rounded-lg">
                <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                </svg>
                <span className="text-sm text-slate-300">{goal.task_title}</span>
              </div>
            </div>
          )}

          {/* Attachments */}
          {goal.attachments && goal.attachments.length > 0 && (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                Attachments ({goal.attachments.length})
              </p>
              <ul className="flex flex-col gap-1.5">
                {goal.attachments.map((att, i) => (
                  <li key={i}>
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
        </div>
      </div>
    </aside>
  );
}
