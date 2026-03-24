import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { getModels, createModel, deleteModel } from '../api';
import type { Model } from '../types';

export default function ModelsPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const { user, logout } = useAuth();

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getModels();
      setModels(data);
    } catch {
      setError('Failed to load models.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError('');
    const name = newName.trim();
    if (!name) {
      setAddError('Model name cannot be empty.');
      return;
    }
    setAdding(true);
    try {
      const created = await createModel(name);
      setModels((prev) => [...prev, created]);
      setNewName('');
    } catch {
      setAddError('Failed to create model. Please try again.');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteModel(id);
      setModels((prev) => prev.filter((m) => m.id !== id));
      setConfirmDeleteId(null);
    } catch {
      // Silently reset on error
    } finally {
      setDeletingId(null);
    }
  };

  const handleLogout = () => {
    logout();
  };

  return (
    <div className="min-h-screen bg-slate-950">
      {/* ── Navigation Header ── */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-sm border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          {/* Left: brand */}
          <div className="flex items-center gap-3">
            <Link
              to="/dashboard"
              className="flex items-center gap-3 hover:opacity-80 transition-opacity"
            >
              <div
                className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600
                           flex items-center justify-center shrink-0"
              >
                <svg
                  className="w-4 h-4 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                  />
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
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Tasks
            </Link>
            <Link
              to="/models"
              className="px-3 py-1.5 text-sm text-slate-100 bg-slate-800 rounded-lg transition-colors font-medium"
            >
              Models
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
              onClick={handleLogout}
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-red-400
                         hover:bg-slate-800 rounded-lg transition-colors"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* ── Page heading ── */}
        <div className="mb-8">
          <div className="flex items-center gap-2 text-sm text-slate-500 mb-3">
            <Link to="/dashboard" className="hover:text-slate-300 transition-colors">
              Sessions
            </Link>
            <span>/</span>
            <span className="text-slate-300">Models</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100">AI Models</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Manage the AI models you use for vibe coding sessions.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* ── Add model form ── */}
          <div className="lg:col-span-2">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <h2 className="text-base font-semibold text-slate-100 mb-4">Add Model</h2>
              <form onSubmit={handleAdd} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="model-name" className="text-sm font-medium text-slate-300">
                    Model Name
                  </label>
                  <input
                    id="model-name"
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    disabled={adding}
                    placeholder="e.g. Claude Sonnet 4.5"
                    className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                               text-sm placeholder:text-slate-500
                               focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                               disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>

                {addError && (
                  <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                    {addError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={adding}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium
                             text-white bg-violet-600 rounded-lg hover:bg-violet-500 transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {adding && (
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  {adding ? 'Adding…' : 'Add Model'}
                </button>
              </form>
            </div>
          </div>

          {/* ── Models list ── */}
          <div className="lg:col-span-3">
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-100">
                  Models
                  {!loading && (
                    <span className="ml-2 text-sm font-normal text-slate-500">
                      ({models.length})
                    </span>
                  )}
                </h2>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-16 gap-3">
                  <div className="w-6 h-6 border-3 border-violet-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-slate-400 text-sm">Loading models…</p>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center py-16 gap-3 text-center px-6">
                  <p className="text-red-400 text-sm">{error}</p>
                  <button
                    onClick={fetchModels}
                    className="text-sm text-violet-400 hover:text-violet-300 underline"
                  >
                    Retry
                  </button>
                </div>
              ) : models.length === 0 ? (
                <div className="flex flex-col items-center py-16 gap-2 text-center px-6">
                  <p className="text-slate-300 font-medium">No models yet</p>
                  <p className="text-slate-500 text-sm">Add your first AI model using the form.</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-800">
                  {models.map((model) => (
                    <li
                      key={model.id}
                      className="flex items-center justify-between px-6 py-3.5 hover:bg-slate-800/50 transition-colors"
                    >
                      <span className="text-sm text-slate-100 font-medium">{model.name}</span>

                      <div className="flex items-center gap-2">
                        {confirmDeleteId === model.id ? (
                          <>
                            <span className="text-xs text-slate-400">Delete?</span>
                            <button
                              onClick={() => handleDelete(model.id)}
                              disabled={deletingId === model.id}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 rounded-lg
                                         hover:bg-red-500 transition-colors disabled:opacity-50
                                         flex items-center gap-1"
                            >
                              {deletingId === model.id && (
                                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              )}
                              Yes
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                            >
                              No
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(model.id)}
                            className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10
                                       rounded-lg transition-colors"
                            title="Delete model"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
