// Ordering and the two summary facts the list needs. Pure, so the screen stays
// about fetching and rendering.
//
// Nothing here computes money. `total`, `amount_paid` and `outstanding` are
// server-owned figures that arrive already computed; this file only decides
// which of them are worth showing on a row.

import type { Invoice, InvoiceStatus } from '@/types';

/** The status filter, with "all" as the extra option the wire does not have. */
export type StatusFilter = InvoiceStatus | 'all';

export const STATUS_FILTERS: Array<[StatusFilter, string]> = [
  ['all', 'All'],
  ['draft', 'Draft'],
  ['sent', 'Sent'],
  ['paid', 'Paid'],
  ['void', 'Void'],
];

/**
 * Newest first, by issue date and then by number.
 *
 * `issue_date` is a bare `YYYY-MM-DD`, which sorts correctly as a string — no
 * `Date`, no timezone, nothing that could shift a day. The number breaks ties
 * because two invoices raised the same day are otherwise in arbitrary order,
 * and `INV-2026-013` sorts after `INV-2026-012` for the same lexicographic
 * reason (the sequence is zero-padded server-side).
 */
export function sortByIssueDesc(invoices: Invoice[]): Invoice[] {
  return [...invoices].sort((a, b) => {
    const byDate = (b.issue_date || '').localeCompare(a.issue_date || '');
    if (byDate !== 0) return byDate;
    return (b.invoice_number || '').localeCompare(a.invoice_number || '');
  });
}

/**
 * Whether a row should carry its paid / outstanding pair.
 *
 * Money has moved (`amount_paid` is non-zero) or the invoice claims to be
 * settled. A `paid` invoice with no payments recorded still shows the pair,
 * deliberately: the outstanding figure is then the whole total, and that
 * mismatch is worth seeing rather than hiding.
 *
 * A refund or a correction can leave `amount_paid` negative, so this tests
 * against zero rather than for a positive.
 */
export function showsPayment(invoice: Invoice): boolean {
  return invoice.amount_paid !== 0 || invoice.status === 'paid';
}

/** `2 projects`, or the single project's name, or the client alone. */
export function projectSummary(invoice: Invoice): string {
  const names = (invoice.project_names || []).filter((name) => name.trim().length > 0);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.length} projects`;
}
