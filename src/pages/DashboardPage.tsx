import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../auth';
import { getGoals, getModels, getTasks, createGoal } from '../api';
import type { Goal, Model, Task } from '../types';
import AppNav from '../components/AppNav';
import GoalCard from '../components/GoalCard';
import GoalPanel from '../components/GoalPanel';
import GoalForm from '../components/GoalForm';

type ModalState = { kind: 'none' } | { kind: 'create' };

export default function DashboardPage() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  const { user } = useAuth();

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [goalsData, modelsData, tasksData] = await Promise.all([getGoals(), getModels(), getTasks()]);
      goalsData.sort(
        (a, b) =>
          new Date(b.datetime_inserted).getTime() - new Date(a.datetime_inserted).getTime()
      );
      setGoals(goalsData);
      setModels(modelsData);
      setTasks(tasksData);
    } catch {
      setError('Failed to load data. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreate = async (data: {
    model_id: string;
    goal: string;
    output: string;
    task_id?: string;
    files: File[];
  }) => {
    const newGoal = await createGoal(
      { model_id: data.model_id, goal: data.goal, output: data.output, task_id: data.task_id },
      data.files
    );
    setGoals((prev) => [newGoal, ...prev]);
    setModal({ kind: 'none' });
  };

  const handleDeleted = (id: string) => {
    setGoals((prev) => prev.filter((g) => g.id !== id));
    setSelectedGoal(null);
  };

  const handleUpdated = (updated: Goal) => {
    setGoals((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
    setSelectedGoal(updated);
  };

  // Stats
  const totalGoals = goals.length;
  const uniqueModelIds = new Set(goals.map((g) => g.model_id));
  const totalModels = uniqueModelIds.size;

  // Filter + sort
  const filteredGoals = goals
    .filter((g) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        g.goal.toLowerCase().includes(q) ||
        g.model_name.toLowerCase().includes(q) ||
        g.output.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      const diff = new Date(a.datetime_inserted).getTime() - new Date(b.datetime_inserted).getTime();
      return sortDir === 'desc' ? -diff : diff;
    });

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      <AppNav active="sessions" />

      <div className="flex flex-1 overflow-hidden">
      <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* ── Page heading ── */}
        <div className="flex items-center justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-100">Sessions</h1>
            <p className="text-sm text-slate-400 mt-0.5">
              {user?.name ? `Welcome back, ${user.name.split(' ')[0]}` : 'Your coding sessions'}
            </p>
          </div>
          <button
            onClick={() => setModal({ kind: 'create' })}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium
                       text-white bg-violet-600 rounded-xl hover:bg-violet-500 transition-colors
                       shadow-lg shadow-violet-500/20 focus:outline-none focus:ring-2
                       focus:ring-violet-500 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New Session
          </button>
        </div>

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Total Sessions</p>
            <p className="text-3xl font-bold text-slate-100">{totalGoals}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Models Used</p>
            <p className="text-3xl font-bold text-slate-100">{totalModels}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 hidden sm:block">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">With Attachments</p>
            <p className="text-3xl font-bold text-slate-100">
              {goals.filter((g) => g.attachments && g.attachments.length > 0).length}
            </p>
          </div>
        </div>

        {/* ── Search + Sort ── */}
        <div className="flex items-center gap-3 mb-6">
          <div className="relative flex-1">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions…"
              className="w-full bg-slate-900 border border-slate-800 text-slate-100 rounded-xl
                         pl-9 pr-4 py-2.5 text-sm placeholder:text-slate-500
                         focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
              >
                ✕
              </button>
            )}
          </div>
          <button
            onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
            className="flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium text-slate-300
                       bg-slate-900 border border-slate-800 rounded-xl hover:bg-slate-800
                       hover:border-slate-700 transition-colors shrink-0"
            title={sortDir === 'desc' ? 'Sorted: Newest first' : 'Sorted: Oldest first'}
          >
            <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              {sortDir === 'desc' ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25-.75L17.25 9m0 0L21 12.75M17.25 9v12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25-.75L17.25 15m0 0L21 11.25M17.25 15V3" />
              )}
            </svg>
            {sortDir === 'desc' ? 'Newest' : 'Oldest'}
          </button>
        </div>

        {/* ── Content ── */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-10 h-10 border-4 border-violet-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">Loading sessions…</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
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
        ) : filteredGoals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
            {searchQuery ? (
              <>
                <p className="text-slate-300 font-medium">No sessions match "{searchQuery}"</p>
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-sm text-violet-400 hover:text-violet-300 underline"
                >
                  Clear search
                </button>
              </>
            ) : (
              <>
                <div className="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center mb-2">
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
                      d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                    />
                  </svg>
                </div>
                <p className="text-slate-300 font-medium">No sessions yet</p>
                <p className="text-slate-500 text-sm">Log your first vibe coding session</p>
                <button
                  onClick={() => setModal({ kind: 'create' })}
                  className="mt-2 px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-xl
                             hover:bg-violet-500 transition-colors"
                >
                  New Session
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredGoals.map((goal) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                onClick={() => setSelectedGoal(goal)}
              />
            ))}
          </div>
        )}
      </div>
      </main>

        {/* ── Session detail side panel ── */}
        {selectedGoal && (
          <GoalPanel
            goal={selectedGoal}
            models={models}
            onClose={() => setSelectedGoal(null)}
            onUpdated={handleUpdated}
            onDeleted={handleDeleted}
          />
        )}
      </div>

      {/* ── Create Modal ── */}
      {modal.kind === 'create' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div
            className="relative w-full max-w-2xl max-h-[90vh] bg-slate-900 border border-slate-800
                       rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
              <h2 className="text-base font-semibold text-slate-100">New Session</h2>
              <button
                onClick={() => setModal({ kind: 'none' })}
                className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin p-6">
              <GoalForm
                models={models}
                tasks={tasks}
                onSubmit={handleCreate}
                onCancel={() => setModal({ kind: 'none' })}
                submitLabel="Create Session"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
