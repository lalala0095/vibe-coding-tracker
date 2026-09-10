// Turning what is on screen into a `CreateInvoicePayload`.
//
// Two rules live here, both of them easy to get wrong silently.

import type { InvoiceLine, InvoicePreviewLine } from '@/types';

// ── The "null" clearing sentinel ──────────────────────────────────────────────
// Optional STRING fields are cleared by sending the literal string "null"
// (`back/routers/invoices.py::_clear_sentinel`). On create the contract is
// three-way:
//
//   key omitted     -> the server applies its settings default
//   value "null"    -> deliberately empty; no default applied
//   any other value -> stored as given
//
// So an emptied due date / tax label / payment terms must send "null". Omitting
// it hands back the settings default the user just cleared, which reads as the
// field refusing to be emptied.
//
// EXCLUDED: `currency` is a string but has no sentinel handling on either path.
// Sending "null" would store and print those four characters on a client-facing
// document. It is omitted when blank instead — never routed through here. The
// payment form's `received_currency` is excluded for the same reason, and says
// so in its own file.
export const CLEAR = 'null';

export function clearable(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? CLEAR : trimmed;
}

/**
 * A previewed line reduced to the stored shape.
 *
 * `InvoicePreviewLine` carries build-time facts — `source`, `claimed_by`,
 * `include_by_default`, `duplicate_reason` — that a stored invoice does not
 * have. They are dropped here rather than riding along in the POST body.
 *
 * ── On `amount` ──────────────────────────────────────────────────────────────
 * It is passed through exactly as the preview returned it, and it is never
 * recomputed on the way out. The server recomputes every money field on write
 * and ignores what the client sent (CLAUDE.md, § Money rules), so the value
 * here is provenance, not arithmetic. `src/lib/money.ts` is used in this screen
 * for the on-screen subtotal only, and none of its output reaches this payload.
 */
export function toInvoiceLine(line: InvoicePreviewLine): InvoiceLine {
  return {
    line_id: line.line_id,
    task_id: line.task_id,
    task_title: line.task_title,
    project_id: line.project_id,
    project_name: line.project_name,
    description: line.description,
    date_from: line.date_from,
    date_to: line.date_to,
    hours: line.hours,
    rate: line.rate,
    amount: line.amount,
    session_ids: line.session_ids ?? [],
    tracker_id: line.tracker_id,
    sub_items: line.sub_items ?? [],
  };
}
