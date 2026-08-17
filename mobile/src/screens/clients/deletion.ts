// What a delete actually leaves behind, said out loud.
//
// ── Deleting does not cascade ────────────────────────────────────────────────
//
// `back/routers/clients.py` and `back/routers/projects.py` both delete exactly
// one document and say so in their docstrings: *"Does not cascade to related
// projects or tasks."* The server does not refuse the delete either — there is
// no in-use check to fail. So a client with live projects under it disappears
// and those projects remain, still carrying the denormalised `client_name` of a
// client that no longer exists.
//
// That is a deliberate server behaviour, not a bug to work around, and per
// CLAUDE.md's no-locking principle the UI must not block it. What the UI owes
// the user is an accurate count of what will be stranded, before they tap.
//
// A count of `null` means "not loaded" rather than "zero" — the tasks list is
// fetched separately and is allowed to fail on its own. Saying "0 tasks" when
// the number is simply unknown would be worse than saying nothing.

/** "3 projects", "1 project", "its projects" when the count is unknown. */
function count(n: number | null, singular: string, plural: string, unknown: string): string {
  if (n === null) return unknown;
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * The consequence line under "Delete <client>?".
 *
 * @param projects Projects belonging to this client.
 * @param tasks    Tasks belonging to this client, or `null` if not loaded.
 */
export function clientDeletionDetail(
  clientName: string,
  projects: number,
  tasks: number | null,
): string {
  // Only the levels that actually have something are named. "0 projects and 5
  // tasks" is accurate and reads like a bug report; "5 tasks" is the sentence a
  // person would write, and a client can genuinely have tasks but no projects
  // once a project has been deleted out from under them.
  const parts = [
    projects > 0 ? count(projects, 'project', 'projects', 'its projects') : null,
    tasks === null || tasks > 0 ? count(tasks, 'task', 'tasks', 'its tasks') : null,
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) {
    return `Nothing else points at ${clientName}. Invoices already issued to it keep their own copy of the billing details, so they are unaffected either way.`;
  }

  // `stranded` opens a sentence, and the unknown-count wording ("its tasks")
  // would otherwise start it in lower case.
  const joined = parts.join(' and ');
  const stranded = joined.charAt(0).toUpperCase() + joined.slice(1);

  // Two parts are always a plural subject; one part agrees with its own count.
  // Without this, a client with a single project reads "1 project stay".
  const singular = parts.length === 1 && (projects === 1 || tasks === 1);

  return (
    `Deleting a client does not delete what sits under it. ${stranded} ${
      singular ? 'stays' : 'stay'
    } in the database, ` +
    // Deliberately no pronoun after the subject: it may be singular or plural,
    // and "1 project stays … they will keep working" does not agree.
    `still labelled ${clientName}, now pointing at a client that no longer exists — still ` +
    `billable, but with no client left to resolve a rate from. Invoices already issued to ` +
    `${clientName} keep their own copy of the billing details and are unaffected.`
  );
}

/**
 * The consequence line under "Delete <project>?".
 *
 * @param tasks Tasks belonging to this project, or `null` if not loaded.
 */
export function projectDeletionDetail(projectName: string, tasks: number | null): string {
  if (tasks === 0) {
    return `No tasks point at ${projectName}. Time entries and invoices keep their own copy of the project name, so they are unaffected either way.`;
  }

  return (
    `Deleting a project does not delete its tasks. ${count(
      tasks,
      'task',
      'tasks',
      'Its tasks',
    )} ${tasks === 1 ? 'stays' : 'stay'} in the database, still labelled ${projectName}, ` +
    `now pointing at a project that no ` +
    `longer exists. Time entries and past invoices keep their own copy of the name and are unaffected.`
  );
}
