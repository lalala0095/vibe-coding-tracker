// What the delete confirmation says.
//
// Split out for the same reason `src/screens/trackers/deletion.ts` is: the copy
// has to name the real consequence, and a consequence stated in three clauses
// inside JSX is a consequence nobody re-reads when the endpoint changes.
//
// The endpoint (`delete_invoice`, back/routers/invoices.py) does two things
// besides removing the document: it clears the invoice back-links on every time
// entry this invoice's lines claimed, and on every tracker billed as a line —
// but only where those documents still point at *this* invoice. Anything since
// pulled onto a newer invoice keeps that newer link. The entries, trackers and
// tasks themselves are untouched; their hours simply read as unbilled again.

import type { Invoice } from '@/types';

/** Unique time entries and trackers this invoice's lines lay claim to. */
function claims(invoice: Invoice): { entries: number; trackers: number } {
  const entries = new Set<string>();
  const trackers = new Set<string>();

  for (const line of invoice.lines ?? []) {
    for (const sessionId of line.session_ids ?? []) entries.add(sessionId);
    if (line.tracker_id) trackers.add(line.tracker_id);
  }

  return { entries: entries.size, trackers: trackers.size };
}

export function invoiceDeletionMessage(invoice: Invoice): string {
  const number = invoice.invoice_number || 'this invoice';
  const client = invoice.client_name ? ` for ${invoice.client_name}` : '';
  return `Delete ${number}${client}? This cannot be undone.`;
}

export function invoiceDeletionDetail(invoice: Invoice): string {
  const { entries, trackers } = claims(invoice);

  const parts: string[] = [];
  if (entries > 0) parts.push(`${entries} time ${entries === 1 ? 'entry' : 'entries'}`);
  if (trackers > 0) parts.push(`${trackers} ${trackers === 1 ? 'tracker' : 'trackers'}`);

  const claimed =
    parts.length > 0
      ? `Deleting it clears the invoice back-links on the ${parts.join(' and ')} it claimed, so that time reads as unbilled and can go on another invoice. The time entries, trackers and tasks themselves are not deleted.`
      : 'This invoice claims no time entries or trackers, so nothing else changes.';

  const payments =
    (invoice.payments ?? []).length > 0
      ? ` The ${invoice.payments.length} recorded ${invoice.payments.length === 1 ? 'payment' : 'payments'} on it will be deleted with it.`
      : '';

  return `${claimed}${payments}`;
}
