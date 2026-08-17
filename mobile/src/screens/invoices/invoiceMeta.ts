// Shared invoice presentation. Small on purpose: it exists so the list, the
// detail view and the payments panel cannot drift on what "sent" looks like or
// how a currency is rendered.
//
// Nothing here computes money. Every monetary figure on an invoice —
// each line's `amount`, `subtotal`, `discount_amount`, `tax_amount`, `total`,
// `total_hours`, and all the payment-derived figures — is computed by the
// server on write and displayed as returned. `src/lib/money.ts` is a verbatim
// copy of the web's implementation and is used ONLY for live totals while
// editing, never to re-derive a stored figure.

import type { InvoiceStatus } from '@/types';
import { formatMoney } from '@/lib/money';

export const INVOICE_STATUSES: InvoiceStatus[] = ['draft', 'sent', 'paid', 'void'];

/** Chip tones, matching the `Chip` primitive's tone names. */
export const STATUS_TONE: Record<InvoiceStatus, 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'indigo'> = {
  draft: 'slate',
  sent: 'blue',
  paid: 'green',
  void: 'red',
};

export const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
  void: 'Void',
};

/**
 * Money for display, in the invoice's own currency.
 *
 * A thin pass-through to `formatMoney` so callers do not each decide what to do
 * with a missing currency. It formats an already-computed value and never
 * rounds one into existence.
 */
export function money(value: number | null | undefined, currency: string | null | undefined): string {
  return formatMoney(typeof value === 'number' ? value : 0, currency || 'USD');
}

/**
 * `1 Jul – 31 Jul 2026`, or a single date, or a plain dash.
 *
 * `period_start`/`period_end` are bare `YYYY-MM-DD` strings with no instant
 * behind them, so this is string work only — no `Date`, no timezone.
 */
export function periodLabel(from: string | null, to: string | null): string {
  const short = (day: string | null): string | null => {
    if (!day) return null;
    const [y, m, d] = day.split('-');
    if (!y || !m || !d) return null;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${Number(d)} ${months[Number(m) - 1] ?? '?'} ${y}`;
  };

  const a = short(from);
  const b = short(to);
  if (a && b) return a === b ? a : `${a} – ${b}`;
  return a ?? b ?? '—';
}
