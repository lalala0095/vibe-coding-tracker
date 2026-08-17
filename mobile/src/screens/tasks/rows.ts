// Turning the flat `GET /tasks` response into the list the screen renders.
//
// The endpoint returns every task, sub-tasks included, in one unpaginated
// array. The web fetches children per expanded parent; on a phone that would be
// a round trip per tap for data already in hand, so the tree is assembled here
// from the single response.
//
// Sub-tasks render indented under their parent. They are now also *managed* —
// created, re-parented and deleted — so this file additionally owns
// `descendantIds`, the cycle guard the parent picker filters with. The server
// stores whatever `parent_task_id` it is given and checks nothing, so the loop
// has to be refused here or not at all.

import { parseSgt } from '@/lib/sgt';
import type { Task, TaskStatus } from '@/types';

export type StatusFilter = TaskStatus | 'all';

export interface TaskFilterState {
  clientId: string | null;
  projectId: string | null;
  status: StatusFilter;
}

export interface TaskRowItem {
  task: Task;
  /** Indent level. 0 is a top-level row. */
  depth: number;
  /**
   * A sub-task shown at depth 0 because its parent is not in the filtered set.
   * Without a marker it would read as a top-level task, which it is not.
   */
  detached: boolean;
}

// Depth is bounded because `parent_task_id` self-nests without limit and a
// 6-inch screen runs out of width long before the data runs out of levels.
const MAX_DEPTH = 5;

function insertedAt(task: Task): number {
  return parseSgt(task.datetime_inserted)?.getTime() ?? 0;
}

export function matchesFilters(task: Task, filters: TaskFilterState): boolean {
  if (filters.clientId && task.client_id !== filters.clientId) return false;
  if (filters.projectId && task.project_id !== filters.projectId) return false;
  if (filters.status !== 'all' && task.status !== filters.status) return false;
  return true;
}

/**
 * Filtered tasks, newest parent first, each followed by its matching children
 * in creation order.
 *
 * A child whose parent is filtered out is not dropped — it surfaces at depth 0
 * flagged `detached`, so narrowing to "urgent" never silently hides work.
 */
export function buildTaskRows(tasks: Task[], filters: TaskFilterState): TaskRowItem[] {
  const matched = tasks.filter((task) => matchesFilters(task, filters));
  const matchedIds = new Set(matched.map((task) => task.id));

  const childrenOf = new Map<string, Task[]>();
  const roots: Task[] = [];

  for (const task of matched) {
    const parentId = task.parent_task_id;
    if (parentId && parentId !== task.id && matchedIds.has(parentId)) {
      const siblings = childrenOf.get(parentId);
      if (siblings) siblings.push(task);
      else childrenOf.set(parentId, [task]);
    } else {
      roots.push(task);
    }
  }

  roots.sort((a, b) => insertedAt(b) - insertedAt(a));
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => insertedAt(a) - insertedAt(b));
  }

  const rows: TaskRowItem[] = [];
  // A `parent_task_id` loop is not something the server prevents, and one would
  // otherwise recurse until the app dies.
  const visited = new Set<string>();

  const visit = (task: Task, depth: number): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);

    rows.push({ task, depth, detached: depth === 0 && task.parent_task_id !== null });

    if (depth >= MAX_DEPTH) return;
    for (const child of childrenOf.get(task.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of roots) visit(root, 0);
  return rows;
}

/**
 * Every task below `rootId`, at any depth.
 *
 * Used for two things, both of which need the *whole* subtree rather than the
 * five levels the list renders:
 *
 *   - the parent picker, which must offer neither the task itself nor anything
 *     under it — `parent_task_id` self-nests and the server accepts a loop
 *     without complaint, so `A → B → A` is stored happily and then hangs
 *     every reader of the tree;
 *   - the delete confirmation, which counts what it is about to strand.
 *
 * `seen` makes this terminate on data that is *already* looped, which is a
 * state the API can return today even though this app will not create it.
 */
export function descendantIds(tasks: Task[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const task of tasks) {
    const parentId = task.parent_task_id;
    if (!parentId || parentId === task.id) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(task.id);
    else childrenOf.set(parentId, [task.id]);
  }

  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const childId of childrenOf.get(id) ?? []) {
      // The root itself can be reached again only through an existing loop;
      // it is not its own descendant, and re-entering it would not terminate.
      if (childId === rootId || seen.has(childId)) continue;
      seen.add(childId);
      stack.push(childId);
    }
  }
  return seen;
}

/** The tasks whose stored `parent_task_id` points straight at `taskId`. */
export function directChildren(tasks: Task[], taskId: string): Task[] {
  return tasks.filter((task) => task.parent_task_id === taskId && task.id !== taskId);
}
