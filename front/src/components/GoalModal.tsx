import { useEffect, useRef, useState } from 'react';
import type { Goal, Model } from '../types';
import { deleteGoal, updateGoal } from '../api';
import GoalForm from './GoalForm';

interface Props {
  goal: Goal;
  models: Model[];
  onClose: () => void;
  onDeleted: (id: string) => void;
  onUpdated: (goal: Goal) => void;
}

function formatDatetime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString('en-SG', {
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

export default function GoalModal({ goal, models, onClose, onDeleted, onUpdated }: Props) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
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

  const handleUpdate = async (data: {
    model_id: string;
    goal: string;
    output: string;
    task_id?: string;
    files: File[];
  }) => {
    const updated = await updateGoal(goal.id, data, data.files);
    onUpdated(updated);
    setEditing(false);
  };

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center p-4
                 bg-black/70 backdrop-blur-sm"
    >
      <div
        className="relative w-full max-w-3xl max-h-[90vh] bg-slate-900 border border-slate-800
                   rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <span
              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                         bg-violet-500/15 text-violet-300 border border-violet-500/25"
            >
              {goal.model_name}
            </span>
            <span className="text-xs text-slate-400">{formatDatetime(goal.datetime_inserted)}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {editing ? (
            <div className="p-6">
              <h3 className="text-base font-semibold text-slate-100 mb-5">Edit Session</h3>
              <GoalForm
                models={models}
                initialValues={goal}
                onSubmit={handleUpdate}
                onCancel={() => setEditing(false)}
                submitLabel="Save Changes"
              />
            </div>
          ) : (
            <div className="p-6 flex flex-col gap-6">
              {/* Goal / Prompt */}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                  Goal / Prompt
                </h3>
                <p className="text-slate-100 text-sm leading-relaxed whitespace-pre-wrap">
                  {goal.goal}
                </p>
              </section>

              {/* AI Output */}
              {goal.output && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                    AI Output
                  </h3>
                  <pre
                    className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-sm
                               text-slate-300 font-mono leading-relaxed whitespace-pre-wrap
                               overflow-x-auto scrollbar-thin"
                  >
                    {goal.output}
                  </pre>
                </section>
              )}

              {/* Attachments */}
              {goal.attachments && goal.attachments.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                    Attachments ({goal.attachments.length})
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {goal.attachments.map((att, i) => (
                      <li key={i}>
                        <a
                          href={att.gcs_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-sm text-violet-400
                                     hover:text-violet-300 underline underline-offset-2 transition-colors"
                        >
                          <svg
                            className="w-4 h-4 shrink-0"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                            />
                          </svg>
                          {att.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>

        {/* ── Footer / Actions ── */}
        {!editing && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 shrink-0">
            {/* Delete zone */}
            <div className="flex items-center gap-3">
              {confirmDelete ? (
                <>
                  <span className="text-sm text-slate-300">Are you sure?</span>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg
                               hover:bg-red-500 transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {deleting && (
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    )}
                    Yes, delete
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-400
                             hover:text-red-300 hover:bg-red-400/10 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete
                </button>
              )}
            </div>

            {/* Edit button */}
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-100
                         bg-slate-800 border border-slate-700 rounded-lg hover:bg-slate-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
