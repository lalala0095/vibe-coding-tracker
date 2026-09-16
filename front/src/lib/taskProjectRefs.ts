// Reading a task's projects. (Front-only; mobile keeps its own lib/taskProjects.ts —
// deliberately a different file name, so scripts/check_shared.py does not
// read the two as one shared copy.)
//
// A task links to one or more projects: `project_ids[0]` is the primary one,
// and `projects` carries the denormalised names in the same order. An older
// server (or an old document the server has not backfilled) may send only the
// legacy scalars `project_id` / `project_name` / `client_id` / `client_name`,
// which always describe the primary. Every helper here falls back to those, so
// callers never have to care which shape arrived.
import type { Task, TaskProjectRef } from '../types';

type TaskLike = Pick<Task, 'project_id' | 'project_name' | 'client_id' | 'client_name'> &
  Partial<Pick<Task, 'project_ids' | 'projects' | 'client_ids'>>;

/** Ordered project ids, primary first. Never empty for a task with a project. */
export function taskProjectIds(task: TaskLike): string[] {
  if (task.project_ids && task.project_ids.length > 0) return task.project_ids;
  if (task.projects && task.projects.length > 0) return task.projects.map((p) => p.project_id);
  return task.project_id ? [task.project_id] : [];
}

/** The primary project id — the one tracker hours and `bill` price against. */
export function primaryProjectId(task: TaskLike): string {
  return taskProjectIds(task)[0] ?? task.project_id ?? '';
}

/** Denormalised project refs, primary first. */
export function taskProjectRefs(task: TaskLike): TaskProjectRef[] {
  if (task.projects && task.projects.length > 0) return task.projects;
  if (!task.project_id) return [];
  return [
    {
      project_id: task.project_id,
      project_name: task.project_name,
      client_id: task.client_id,
      client_name: task.client_name,
    },
  ];
}

export function taskClientIds(task: TaskLike): string[] {
  if (task.client_ids && task.client_ids.length > 0) return task.client_ids;
  const seen: string[] = [];
  for (const p of taskProjectRefs(task)) {
    if (p.client_id && !seen.includes(p.client_id)) seen.push(p.client_id);
  }
  return seen;
}

export function taskHasProject(task: TaskLike, projectId: string): boolean {
  return taskProjectIds(task).includes(projectId);
}

export function taskHasClient(task: TaskLike, clientId: string): boolean {
  return taskClientIds(task).includes(clientId);
}

/**
 * "Client / Project" for a single-project task, as the UI has always shown it.
 * Several projects: grouped by client, "Acme / Web, API · Globex / Audit",
 * primary's client first.
 */
export function taskProjectsLabel(task: TaskLike): string {
  const refs = taskProjectRefs(task);
  if (refs.length === 0) return `${task.client_name} / ${task.project_name}`;
  const groups: { client: string; names: string[] }[] = [];
  for (const r of refs) {
    const g = groups.find((x) => x.client === r.client_name);
    if (g) g.names.push(r.project_name);
    else groups.push({ client: r.client_name, names: [r.project_name] });
  }
  return groups.map((g) => `${g.client} / ${g.names.join(', ')}`).join(' · ');
}
