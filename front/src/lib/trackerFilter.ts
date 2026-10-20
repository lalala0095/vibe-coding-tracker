// Filtering trackers by client and project.
//
// A tracker has no project of its own (see CLAUDE.md, "Traps"). It reaches one
// only through its tasks: `TrackerTaskRef.task_id` → the task's `project_ids`
// (every one of them, not just the primary — a filter asks "does this tracker
// touch that project", not "what would it be billed against") → project →
// `client_id`. `TrackerTaskRef` itself carries no ids, only denormalised names,
// so the task list is what makes the hop.
//
// A task that has since been deleted falls back to the ref's own
// (client_name, project_name) pair, the same fallback `weeklySummary.ts` uses —
// and like there, a pair two projects share resolves to nothing rather than to
// a guess.
import type { Project, Task, Tracker } from '../types';
import { taskProjectIds } from './taskProjectRefs';

export interface TrackerFilterInput {
  tasks: Task[];
  projects: Project[];
  clientId: string;    // '' = any client
  projectId: string;   // '' = any project
}

/**
 * The trackers matching a client/project filter. With neither set, every
 * tracker passes untouched. With either set, a tracker passes when ANY of its
 * tasks links to a matching project; trackers with no tasks, or whose tasks
 * resolve to no project, are left out.
 */
export function filterTrackersByProject(
  trackers: Tracker[],
  { tasks, projects, clientId, projectId }: TrackerFilterInput,
): Tracker[] {
  if (!clientId && !projectId) return trackers;

  // The project ids that count as a match. A chosen project wins; otherwise
  // every project of the chosen client.
  const wanted = new Set<string>(
    projectId
      ? [projectId]
      : projects.filter((p) => p.client_id === clientId).map((p) => p.id),
  );
  if (wanted.size === 0) return [];

  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const projectByName = new Map<string, Project | null>();
  for (const p of projects) {
    const key = `${p.client_name} ${p.name}`;
    projectByName.set(key, projectByName.has(key) ? null : p);
  }

  return trackers.filter((tracker) =>
    tracker.tasks.some((ref) => {
      const task = taskById.get(ref.task_id);
      const ids = task
        ? taskProjectIds(task)
        : (() => {
            const p = projectByName.get(`${ref.client_name} ${ref.project_name}`);
            return p ? [p.id] : [];
          })();
      return ids.some((id) => wanted.has(id));
    }),
  );
}
