// Move several tasks to another project in one go.
//
// The whole difficulty here is the tree. Tasks self-nest through
// `parent_task_id`, and `PUT /tasks/{id}` re-denormalises `project_name`,
// `client_id` and `client_name` for the one task it is given and nothing else.
// So moving a parent and leaving its children behind leaves a child sitting in
// a different project from its parent — a shape the task list cannot render
// correctly and that nothing server-side rejects. This dialog therefore walks
// the full descendant set before it moves anything, says out loud how many
// sub-tasks are coming along, and moves them too. "Move the parent only" is
// deliberately not offered: it produces invalid data.
//
// The mirror-image break is a sub-task selected on its own, with its parent
// left behind. That is the same broken shape, but it can also be exactly what
// the owner meant (re-homing a branch). Per CLAUDE.md's no-locking principle it
// is warned about, loudly, and never blocked.
//
// There is no bulk endpoint and no transaction: this is N sequential PUTs. Some
// can succeed and some fail. When that happens the successful moves stay moved
// — they cannot be rolled back — and the dialog names every task that failed
// rather than reporting a success it did not achieve.

import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { getTasks, updateTask } from '../api';
import type { Client, Project, Task } from '../types';
import Modal, {
  ButtonSpinner,
  MODAL_CANCEL_BUTTON,
  MODAL_PRIMARY_BUTTON,
} from './Modal';

// ── Helpers ───────────────────────────────────────────────────────────────────

// The API answers a rejected write with a `detail` string worth showing
// verbatim. Anything else falls back to the caller's message.
function errorDetail(e: unknown, fallback: string): string {
  if (axios.isAxiosError(e)) {
    const data: unknown = e.response?.data;
    if (data && typeof data === 'object' && 'detail' in data) {
      const detail = (data as { detail: unknown }).detail;
      if (typeof detail === 'string' && detail.trim()) return detail;
    }
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Failure {
  id: string;
  title: string;
  message: string;
}

interface Resolved {
  /** The selection itself, deduped, in the order it was given. */
  roots: Task[];
  /** Everything under the roots that was not already selected. */
  descendants: Task[];
  /**
   * Roots that have a parent which is *not* travelling with them. Moving one
   * separates it from its parent — allowed, but worth saying.
   */
  orphaned: Task[];
}

type Phase =
  | { kind: 'resolving' }
  | { kind: 'resolve_failed'; message: string }
  | { kind: 'ready' }
  | { kind: 'moving'; done: number; total: number }
  | { kind: 'result'; moved: number; skipped: number; failures: Failure[] };

interface Props {
  /** The selected tasks. Snapshotted on mount — see the note in the body. */
  tasks: Task[];
  clients: Client[];
  projects: Project[];
  /**
   * Called once the run ends with at least one task actually moved, so the
   * page can refresh and drop its selection. The dialog stays open afterwards
   * if anything failed, so the report survives the refresh.
   */
  onMoved: () => void;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BulkMoveTasksModal({
  tasks,
  clients,
  projects,
  onMoved,
  onClose,
}: Props) {
  // Snapshotted on mount on purpose. `onMoved` makes the page clear its
  // selection, which empties the `tasks` prop while this dialog is still up
  // showing a failure report about those very tasks.
  const [selection] = useState<Task[]>(() => {
    const seen = new Set<string>();
    return tasks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  });

  const [phase, setPhase] = useState<Phase>({ kind: 'resolving' });
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [destProjectId, setDestProjectId] = useState<string>('');

  // ── Resolve the descendant set ─────────────────────────────────────────────
  // Breadth-first, one round of requests per level rather than one per task in
  // series. `seen` is seeded with the whole selection, which is what stops a
  // task that was selected *and* is a child of another selected task from being
  // queued twice — and, defensively, stops a cycle in `parent_task_id` from
  // looping forever.
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;

    (async () => {
      const seen = new Set<string>(selection.map((t) => t.id));
      const descendants: Task[] = [];
      let frontier: string[] = selection.map((t) => t.id);

      try {
        while (frontier.length > 0) {
          const levels = await Promise.all(
            frontier.map((id) => getTasks({ parent_task_id: id }))
          );
          if (cancelled.current) return;

          const next: string[] = [];
          for (const children of levels) {
            for (const child of children) {
              if (seen.has(child.id)) continue;
              seen.add(child.id);
              descendants.push(child);
              next.push(child.id);
            }
          }
          frontier = next;
        }
      } catch (e) {
        if (cancelled.current) return;
        setPhase({
          kind: 'resolve_failed',
          message: errorDetail(
            e,
            'Could not load the sub-tasks under this selection.'
          ),
        });
        return;
      }

      if (cancelled.current) return;
      const orphaned = selection.filter(
        (t) => t.parent_task_id && !seen.has(t.parent_task_id)
      );
      setResolved({ roots: selection, descendants, orphaned });
      setPhase({ kind: 'ready' });
    })();

    return () => {
      cancelled.current = true;
    };
  }, [selection]);

  // ── Destination ────────────────────────────────────────────────────────────

  const destProject = projects.find((p) => p.id === destProjectId) ?? null;
  const destLabel = destProject
    ? `${destProject.client_name} / ${destProject.name}`
    : '';

  // Same client / project tree the Tasks sidebar uses.
  const clientProjectGroups = useMemo(
    () =>
      clients.map((c) => ({
        client: c,
        projects: projects.filter((p) => p.client_id === c.id),
      })),
    [clients, projects]
  );

  // Everything that will be moved, parents before their children. Tasks already
  // sitting in the destination are skipped — the write would be a no-op that
  // only bumps `datetime_updated`.
  const moveList = useMemo(() => {
    if (!resolved || !destProjectId) return [];
    return [...resolved.roots, ...resolved.descendants].filter(
      (t) => t.project_id !== destProjectId
    );
  }, [resolved, destProjectId]);

  const totalInScope = resolved
    ? resolved.roots.length + resolved.descendants.length
    : 0;
  const alreadyThere = destProjectId ? totalInScope - moveList.length : 0;

  // ── The move ───────────────────────────────────────────────────────────────

  const runMove = async () => {
    if (!destProjectId || moveList.length === 0) return;

    const failures: Failure[] = [];
    let moved = 0;

    setPhase({ kind: 'moving', done: 0, total: moveList.length });

    // Sequential on purpose: it keeps the progress count meaningful and does
    // not fan a large selection at the API all at once.
    for (const task of moveList) {
      try {
        await updateTask(task.id, { project_id: destProjectId }, []);
        moved += 1;
      } catch (e) {
        failures.push({
          id: task.id,
          title: task.title,
          message: errorDetail(e, 'The move was rejected.'),
        });
      }
      setPhase({ kind: 'moving', done: moved + failures.length, total: moveList.length });
    }

    setPhase({ kind: 'result', moved, skipped: alreadyThere, failures });

    // Refresh the page behind us as soon as anything actually changed, even on
    // a partial failure — those moves are real and must show.
    if (moved > 0) onMoved();
    if (failures.length === 0) onClose();
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const busy = phase.kind === 'moving';

  const footer = (() => {
    if (phase.kind === 'result') {
      return (
        <>
          <span className="text-xs text-slate-500">
            Successful moves have been saved.
          </span>
          <button type="button" onClick={onClose} className={MODAL_PRIMARY_BUTTON}>
            Done
          </button>
        </>
      );
    }
    return (
      <>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={MODAL_CANCEL_BUTTON}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={runMove}
          disabled={busy || phase.kind !== 'ready' || !destProjectId || moveList.length === 0}
          className={MODAL_PRIMARY_BUTTON}
        >
          {busy && <ButtonSpinner />}
          {busy
            ? 'Moving…'
            : moveList.length > 0
            ? `Move ${plural(moveList.length, 'task', 'tasks')}`
            : 'Move'}
        </button>
      </>
    );
  })();

  return (
    <Modal title="Move tasks to another project" onClose={onClose} size="md" footer={footer}>
      {/* ── Resolving the tree ── */}
      {phase.kind === 'resolving' && (
        <div className="flex items-center gap-3 py-6 text-sm text-slate-400">
          <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
          Finding every sub-task under the {plural(selection.length, 'selected task', 'selected tasks')}…
        </div>
      )}

      {phase.kind === 'resolve_failed' && (
        <div className="py-2">
          <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
            {phase.message}
          </p>
          <p className="text-xs text-slate-500 mt-3">
            Nothing has been moved. Sub-tasks have to travel with their parents,
            so the move is not offered until the full list is known.
          </p>
        </div>
      )}

      {/* ── Result ── */}
      {phase.kind === 'result' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-slate-100 font-medium">
              {phase.failures.length === 0
                ? `Moved ${plural(phase.moved, 'task', 'tasks')} to ${destLabel}.`
                : `${plural(phase.moved, 'task', 'tasks')} moved, ${plural(
                    phase.failures.length,
                    'task',
                    'tasks'
                  )} failed.`}
            </p>
            {phase.skipped > 0 && (
              <p className="text-xs text-slate-500">
                {plural(phase.skipped, 'task was', 'tasks were')} already in{' '}
                {destLabel} and left alone.
              </p>
            )}
          </div>

          {phase.failures.length > 0 && (
            <div className="rounded-lg border border-red-400/20 bg-red-400/5 overflow-hidden">
              <p className="px-4 py-2.5 text-xs font-semibold text-red-300 uppercase tracking-wider border-b border-red-400/20">
                Not moved
              </p>
              <ul className="divide-y divide-red-400/10">
                {phase.failures.map((f) => (
                  <li key={f.id} className="px-4 py-2.5">
                    <p className="text-sm text-slate-100 truncate">{f.title}</p>
                    <p className="text-xs text-red-400 mt-0.5">{f.message}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {phase.failures.length > 0 && (
            <p className="text-xs text-slate-500">
              There is no bulk endpoint to roll back, so the{' '}
              {plural(phase.moved, 'task that moved is', 'tasks that moved are')}{' '}
              still in {destLabel}. The ones listed above kept their old project.
              Re-select them and try again.
            </p>
          )}
        </div>
      )}

      {/* ── Picker + summary + progress ── */}
      {(phase.kind === 'ready' || phase.kind === 'moving') && resolved && (
        <>
          {/* What is about to happen */}
          <div className="rounded-lg border border-slate-700 bg-slate-950/60 px-4 py-3">
            <p className="text-sm text-slate-100">
              Moving{' '}
              <span className="font-semibold text-violet-300">
                {plural(resolved.roots.length, 'task', 'tasks')}
              </span>
              {resolved.descendants.length > 0 ? (
                <>
                  {' '}and{' '}
                  <span className="font-semibold text-violet-300">
                    {plural(resolved.descendants.length, 'sub-task', 'sub-tasks')}
                  </span>{' '}
                  under them
                </>
              ) : (
                <> — no sub-tasks under {resolved.roots.length === 1 ? 'it' : 'them'}</>
              )}
              {destProject ? (
                <>
                  {' '}to <span className="font-semibold text-slate-100">{destLabel}</span>.
                </>
              ) : (
                <>. Pick a destination project below.</>
              )}
            </p>
            {resolved.descendants.length > 0 && (
              <p className="text-xs text-slate-500 mt-1.5">
                Sub-tasks always travel with their parent — a child left behind
                would sit in a different project from the task it belongs to.
              </p>
            )}
          </div>

          {/* Selected sub-task with its parent left behind */}
          {resolved.orphaned.length > 0 && (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3">
              <p className="text-sm text-amber-200 font-medium">
                {plural(resolved.orphaned.length, 'selected task is a sub-task', 'selected tasks are sub-tasks')}{' '}
                whose parent is not in this move.
              </p>
              <p className="text-xs text-amber-200/70 mt-1">
                Moving{' '}
                {resolved.orphaned.length === 1 ? 'it' : 'them'} leaves{' '}
                {resolved.orphaned.length === 1 ? 'it' : 'them'} in a different
                project from{' '}
                {resolved.orphaned.length === 1 ? 'its parent' : 'their parents'}.
                That is allowed — select the parent too if you did not mean it.
              </p>
              <ul className="mt-2 flex flex-col gap-0.5">
                {resolved.orphaned.map((t) => (
                  <li key={t.id} className="text-xs text-amber-200/90 truncate">
                    · {t.title}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Destination picker — the sidebar's client / project tree */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Destination project
            </label>
            {projects.length === 0 ? (
              <p className="text-sm text-slate-500 italic">
                There are no projects to move these tasks to.
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950/60 py-1.5">
                {clientProjectGroups.map(({ client, projects: cProjects }) => (
                  <div key={client.id}>
                    <p className="px-3 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider truncate">
                      {client.name}
                    </p>
                    {cProjects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setDestProjectId(p.id)}
                        disabled={busy}
                        className={`w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-sm text-left transition-colors disabled:opacity-50
                          ${destProjectId === p.id
                            ? 'text-violet-400 bg-violet-400/10 font-medium'
                            : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                          }`}
                      >
                        <span className="w-1 h-1 rounded-full bg-current shrink-0 opacity-60" />
                        <span className="truncate">{p.name}</span>
                      </button>
                    ))}
                    {cProjects.length === 0 && (
                      <p className="pl-6 pr-3 py-1.5 text-xs text-slate-600 italic">
                        No projects
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Already in the destination */}
          {phase.kind === 'ready' && destProjectId && alreadyThere > 0 && (
            <p className="text-xs text-slate-500">
              {plural(alreadyThere, 'task is', 'tasks are')} already in {destLabel}{' '}
              and will be left alone.
            </p>
          )}

          {phase.kind === 'ready' && destProjectId && moveList.length === 0 && (
            <p className="text-sm text-slate-400">
              Everything selected, and every sub-task under it, is already in{' '}
              {destLabel}. There is nothing to move.
            </p>
          )}

          {/* Progress */}
          {phase.kind === 'moving' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">
                  Moving task {Math.min(phase.done + 1, phase.total)} of {phase.total}…
                </span>
                <span className="text-slate-500 tabular-nums">
                  {phase.done}/{phase.total}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-violet-500 transition-all duration-200"
                  style={{ width: `${phase.total === 0 ? 0 : (phase.done / phase.total) * 100}%` }}
                />
              </div>
              <p className="text-xs text-slate-500">
                One request per task — closing this now would stop the rest, but
                would not undo what has already moved.
              </p>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
