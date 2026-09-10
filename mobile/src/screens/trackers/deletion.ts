// What the delete confirmation says, and why it says it.
//
// Deleting a tracker **does not cascade** — `back/routers/trackers.py:660`
// deletes the document and stops. Two consequences outlive the tracker, and
// both are invisible from this screen afterwards, so both are said before:
//
//   1. Time entries created from it survive. They keep a `tracker_id` that no
//      longer resolves and they stay billable, which is deliberate server-side:
//      billed hours must not vanish because the block they came from was tidied
//      away.
//   2. If the tracker is already a line on an invoice, that invoice keeps the
//      line. Invoice lines are snapshots (CLAUDE.md § Invoicing), so nothing
//      about the invoice changes — including the fact that it is still claiming
//      these hours.
//
// The user is then told to go ahead. Warn, never block.

import type { Tracker } from '@/types';

/**
 * The second line of the confirmation.
 *
 * @param entryCount time entries created from this tracker, or `null` when the
 *                   lookup failed — a count is a sharpening, never a gate, so
 *                   the unknown case still says the important part.
 */
export function trackerDeletionDetail(tracker: Tracker, entryCount: number | null): string {
  const parts: string[] = [];

  if (entryCount === null) {
    parts.push(
      'Deleting a tracker does not cascade. Any time entries already created from it stay exactly ' +
        'as they are — still on the Time Entries tab, still billable, holding a link back to a ' +
        'tracker that no longer exists.',
    );
  } else if (entryCount === 0) {
    parts.push(
      'No time entries have been created from this tracker, so nothing billable is left behind. ' +
        'Its tasks are not deleted either — only the block itself goes.',
    );
  } else {
    parts.push(
      'Deleting a tracker does not cascade. ' +
        (entryCount === 1
          ? 'The one time entry created from it survives'
          : `All ${entryCount} time entries created from it survive`) +
        ' — still on the Time Entries tab, still billable, holding a link back to a tracker that ' +
        'no longer exists.',
    );
  }

  if (tracker.invoice_numbers.length > 0) {
    parts.push(
      `This tracker is already billed on ${
        tracker.invoice_numbers.length === 1 ? 'invoice' : 'invoices'
      } ${tracker.invoice_numbers.join(', ')}. Those invoices keep their lines and their totals ` +
        'exactly as issued; deleting the tracker here changes nothing on them.',
    );
  }

  parts.push('The tasks in the block are not deleted.');

  return parts.join(' ');
}

/** The first line — name the thing being deleted. */
export function trackerDeletionMessage(tracker: Tracker): string {
  return `Delete "${tracker.title}"?`;
}
