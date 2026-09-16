// Reading a task's projects — the one place the phone decides what "a task's
// projects" means.
//
// A task links to one or more projects (`project_ids`, ordered, `[0]` is the
// primary) and so possibly to several clients. The server always returns the
// list, and derives it for older documents that only carry the legacy
// `project_id` scalar. These helpers still fall back to the scalars, so a
// response from a server that predates the change never reads as "no project".
//
// Not one of the shared copies of `front/src/lib` (see scripts/check_shared.py):
// this file is mobile's own and may be edited freely.

import type { Task, TaskProjectRef } from '@/types';

/** Ordered, non-empty project ids. `[0]` is the primary. */
export function taskProjectIds(task: Task): string[] {
  if (Array.isArray(task.project_ids) && task.project_ids.length > 0) return task.project_ids;
  return task.project_id ? [task.project_id] : [];
}

/** The denormalised project/client chain for each project, in the same order. */
export function taskProjects(task: Task): TaskProjectRef[] {
  if (Array.isArray(task.projects) && task.projects.length > 0) return task.projects;
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

/** Distinct client ids, first-seen order. */
export function taskClientIds(task: Task): string[] {
  if (Array.isArray(task.client_ids) && task.client_ids.length > 0) return task.client_ids;
  return task.client_id ? [task.client_id] : [];
}

export function taskHasProject(task: Task, projectId: string): boolean {
  return taskProjectIds(task).includes(projectId);
}

export function taskHasClient(task: Task, clientId: string): boolean {
  return taskClientIds(task).includes(clientId);
}

/**
 * `Acme / Website, API` — or, across clients, `Acme / Website · Globex / Audit`.
 *
 * Projects are grouped under their client in first-seen order, so the primary
 * project's client always leads.
 */
export function taskProjectsLabel(task: Task): string {
  const byClient = new Map<string, { name: string; projects: string[] }>();
  for (const ref of taskProjects(task)) {
    const key = ref.client_id || ref.client_name;
    const group = byClient.get(key);
    if (group) group.projects.push(ref.project_name);
    else byClient.set(key, { name: ref.client_name, projects: [ref.project_name] });
  }
  return [...byClient.values()]
    .map((group) => `${group.name} / ${group.projects.filter(Boolean).join(', ')}`)
    .join(' · ');
}

/** `Website, API` — project names only, primary first. */
export function taskProjectNames(task: Task): string {
  return taskProjects(task)
    .map((ref) => ref.project_name)
    .filter(Boolean)
    .join(', ');
}
