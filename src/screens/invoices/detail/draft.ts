// The editable shape of an invoice, and the one place that turns it back into
// a wire payload.
//
// ── Why there is a draft at all ──────────────────────────────────────────────
//
// Every money field on an invoice is server-owned: `amount` per line,
// `subtotal`, `discount_amount`, `tax_amount`, `total` and `total_hours` are
// recomputed on every write and ignored if sent. So an edit is not "change a
// number and reconcile"; it is "collect what the user typed, post it, and show
// what comes back". This module holds the middle step.
//
// Numbers are held as **text**, for the reason `NumberField` documents: "1."
// is not a number, "1.50" round-trips to "1.5", and an empty box would become
// "0" under the typist's fingers. They convert once, on save.
//
// ── computeMoney is a preview, never a derivation ────────────────────────────
//
// `previewTotals` below is the only caller of `computeMoney` in the detail
// screen, and it runs on the **draft**, not on the invoice. Its job is to show
// what a rate change will do before it is saved. The instant the server
// responds, the screen shows the server's figures again and this function's
// output is discarded. Nothing here ever recomputes a stored figure — a
// historical invoice must read the numbers it was saved with, even after a
// rate or a tax setting has moved (CLAUDE.md, "Do not recompute in the print
// view", which is the same rule seen from the other end).
//
// ── Snapshots ────────────────────────────────────────────────────────────────
//
// `task_title`, `project_name`, `sub_items`, and each line's `rate` were
// resolved when the invoice was built and frozen there. They are carried
// through this draft verbatim and are never re-resolved from the client, the
// project or the task. That is the whole reason invoices copy instead of
// referencing.

import { parseNumberInput } from '@/components';
import { computeMoney, type MoneyTotals } from '@/lib/money';
import { parseSgt, sgtDay } from '@/lib/sgt';
import type { Invoice, InvoiceLine, UpdateInvoicePayload } from '@/types';

// ── The draft ────────────────────────────────────────────────────────────────

export interface LineDraft {
  /**
   * A stable React key. Local only and never sent: a line added on the phone
   * has no `line_id` until the server assigns one, and keying off the array
   * index would make a removal re-key every line below it, moving the focused
   * text input to a different row mid-edit.
   */
  key: string;
  /** Empty on a line added here — `_build_lines` assigns the id on save. */
  line_id: string;
  task_id: string | null;
  /** Snapshot. Displayed, never re-fetched from the task. */
  task_title: string;
  project_id: string | null;
  /** Snapshot. */
  project_name: string;
  description: string;
  /** Bare `YYYY-MM-DD`, as stored. */
  date_from: string | null;
  date_to: string | null;
  /** Raw text — see the header. */
  hours: string;
  rate: string;
  /** Provenance, carried through untouched. */
  session_ids: string[];
  tracker_id: string | null;
  /** Snapshot of the task titles printed under the description. */
  sub_items: string[];
}

export interface InvoiceDraft {
  lines: LineDraft[];
  discount_type: 'percent' | 'amount' | null;
  discount_value: string;
  tax_label: string;
  tax_percent: string;
  notes: string;
  payment_terms: string;
  /** Bare `YYYY-MM-DD`, or null for no due date. */
  due_date: string | null;
}

// Keys for lines added on the phone. A module-level counter rather than a
// timestamp: two lines added in the same millisecond would collide.
let addedLineCount = 0;

/**
 * A stored number as editable text.
 *
 * `String` gives the shortest round-tripping decimal form — 2.5 stays "2.5"
 * rather than becoming "2.50" — which is the literal the user would have
 * typed. Deliberately not `toFixed`: this text is parsed back into a number on
 * save, and `toFixed` is the half-cent trap (`(1.005).toFixed(2)` is "1.00").
 * Formatting for *display* goes through `formatMoney` / `formatHours`.
 */
function numberText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(value);
}

function lineDraft(line: InvoiceLine): LineDraft {
  return {
    key: line.line_id,
    line_id: line.line_id,
    task_id: line.task_id,
    task_title: line.task_title,
    project_id: line.project_id,
    project_name: line.project_name,
    description: line.description,
    date_from: line.date_from,
    date_to: line.date_to,
    hours: numberText(line.hours),
    rate: numberText(line.rate),
    session_ids: line.session_ids ?? [],
    tracker_id: line.tracker_id,
    sub_items: line.sub_items ?? [],
  };
}

/** The draft an invoice starts an edit from. */
export function draftFromInvoice(invoice: Invoice): InvoiceDraft {
  return {
    lines: (invoice.lines ?? []).map(lineDraft),
    discount_type: invoice.discount_type,
    discount_value: numberText(invoice.discount_value),
    tax_label: invoice.tax_label ?? '',
    tax_percent: numberText(invoice.tax_percent),
    notes: invoice.notes ?? '',
    payment_terms: invoice.payment_terms ?? '',
    due_date: invoice.due_date,
  };
}

/**
 * A blank line, added by hand.
 *
 * No task, no project, no provenance — a manual line is exactly the case
 * `task_id: null` exists for. Hours and rate start empty rather than at "0" so
 * the field does not have to be cleared before a figure can be typed.
 */
export function blankLine(): LineDraft {
  addedLineCount += 1;
  return {
    key: `added-${addedLineCount}`,
    line_id: '',
    task_id: null,
    task_title: '',
    project_id: null,
    project_name: '',
    description: '',
    date_from: null,
    date_to: null,
    hours: '',
    rate: '',
    session_ids: [],
    tracker_id: null,
    sub_items: [],
  };
}

// ── Dates ────────────────────────────────────────────────────────────────────

/**
 * A `DateTimeField` value back into the bare `YYYY-MM-DD` these fields store.
 *
 * The field speaks full wire timestamps; `date_from`, `date_to` and `due_date`
 * are date-only. `parseSgt` reads a bare day as Singapore midnight and
 * `sgtDay` reads the Singapore calendar date back out, so a phone in another
 * timezone cannot shift the day. **Never `.toISOString()`** — that is UTC, and
 * between midnight and 08:00 SGT it names the day before.
 */
export function dayFromFieldValue(value: string | null): string | null {
  const parsed = parseSgt(value);
  return parsed ? sgtDay(parsed) : null;
}

// ── Live totals, while editing ───────────────────────────────────────────────

/** A previewed line, carrying the draft key so the row can find its amount. */
export interface PreviewLine {
  key: string;
  hours: number;
  rate: number;
  amount: number;
}

export type DraftTotals = MoneyTotals<PreviewLine>;

/**
 * What the invoice *would* total if saved right now.
 *
 * A preview for the person typing, and nothing more — see the header. It runs
 * the verbatim copy of the web's arithmetic, so the figure on screen is the
 * figure the server will compute: quantise each line to 2 dp before summing,
 * and apply tax to the discounted subtotal. None of that is reimplemented
 * here; `computeMoney` owns all of it.
 *
 * A half-typed box ("1.", "-", "") reads as 0 rather than as a hole, so the
 * preview stays a number throughout the keystroke.
 */
export function previewTotals(draft: InvoiceDraft): DraftTotals {
  return computeMoney<PreviewLine>(
    draft.lines.map((line) => ({
      key: line.key,
      hours: parseNumberInput(line.hours) ?? 0,
      rate: parseNumberInput(line.rate) ?? 0,
      // Ignored by `computeMoney`, which overwrites it. Present because the
      // shared line shape carries it.
      amount: 0,
    })),
    draft.discount_type,
    parseNumberInput(draft.discount_value) ?? 0,
    parseNumberInput(draft.tax_percent) ?? 0,
  );
}

/**
 * A discount bigger than the subtotal.
 *
 * **Not an error, and never clamped** (CLAUDE.md money rule 4): the server is a
 * pure calculator, it stores and prints the negative total as computed, and the
 * user owns their numbers. The UI says so loudly and lets the save through.
 *
 * Takes the two figures rather than a `DraftTotals` so it reads a **stored**
 * invoice as readily as a preview. An invoice already saved with a negative
 * total has to carry the warning too — the condition is a fact about the
 * numbers, not about whether there is an edit in progress.
 */
export function isOverDiscounted(totals: {
  subtotal: number;
  discount_amount: number;
}): boolean {
  return totals.discount_amount > totals.subtotal;
}

// ── Dirty tracking ───────────────────────────────────────────────────────────

/**
 * A comparable form of the draft, ignoring the local-only React keys.
 *
 * Text-level rather than numeric: typing "2.50" over a stored 2.5 counts as a
 * change. That is the safe direction — it offers a save that turns out to be a
 * no-op, rather than hiding one that is not.
 */
function fingerprint(draft: InvoiceDraft): string {
  return JSON.stringify({
    ...draft,
    lines: draft.lines.map(({ key: _key, ...rest }) => rest),
  });
}

export function isDirty(draft: InvoiceDraft, invoice: Invoice): boolean {
  return fingerprint(draft) !== fingerprint(draftFromInvoice(invoice));
}

// ── The wire payload ─────────────────────────────────────────────────────────

/**
 * The draft as an `updateInvoice` body.
 *
 * ── Clearing conventions, which differ by field ──
 *
 * `due_date`, `notes`, `payment_terms`, `tax_label` and `discount_type` are
 * **string** fields cleared with the literal string `"null"`
 * (`_clear_sentinel`, `back/routers/invoices.py:306`). A real JSON `null`
 * would fail the `is not None` guard above each one and be silently ignored,
 * leaving the old value in place.
 *
 * `discount_value` and `tax_percent` take **no sentinel at all**. They are
 * non-nullable on the response, so there is no cleared state to express, and
 * the endpoint explicitly treats an incoming null as "not supplied" — writing
 * one would poison the document and 500 every subsequent read. Emptying either
 * box therefore sends `0`, which is what "no discount" and "no tax" mean
 * arithmetically.
 *
 * `currency` is **never sent by this screen and must never receive `"null"`**.
 * It is non-nullable, has no "no currency" meaning, and the sentinel would be
 * stored and then printed as the word "null" on a client-facing document.
 *
 * ── Why every field goes every time ──
 *
 * The endpoint recomputes all the money from whichever of lines / discount /
 * tax the payload carries, falling back to the stored values for the rest.
 * Sending the complete set means the recompute always runs against what is on
 * screen, and re-sending an unchanged value is a no-op.
 */
export function toUpdatePayload(draft: InvoiceDraft): UpdateInvoicePayload {
  return {
    lines: draft.lines.map((line) => ({
      line_id: line.line_id,
      task_id: line.task_id,
      task_title: line.task_title,
      project_id: line.project_id,
      project_name: line.project_name,
      // `_build_lines` falls back to the task title when this is blank, which
      // is the same default the invoice was built with.
      description: line.description,
      date_from: line.date_from,
      date_to: line.date_to,
      hours: parseNumberInput(line.hours) ?? 0,
      rate: parseNumberInput(line.rate) ?? 0,
      // The server owns this field: `InvoiceLineInput` has no `amount` at all,
      // so whatever is sent is dropped and the amount is recomputed from hours
      // × rate. It is present only because the shared `InvoiceLine` type is the
      // *response* shape. Zero, never a computed total — posting one would
      // imply the client had a say in it.
      amount: 0,
      session_ids: line.session_ids,
      tracker_id: line.tracker_id,
      sub_items: line.sub_items,
    })),

    // String sentinels.
    due_date: draft.due_date ?? 'null',
    notes: draft.notes.trim() || 'null',
    payment_terms: draft.payment_terms.trim() || 'null',
    tax_label: draft.tax_label.trim() || 'null',
    // The sentinel is a wire value, not a stored one, so it does not fit the
    // response type's `'percent' | 'amount' | null`. The cast is the sentinel
    // crossing that boundary and is the only one in this file.
    discount_type: (draft.discount_type ?? 'null') as UpdateInvoicePayload['discount_type'],

    // Numerics: 0 rather than a sentinel — see above.
    discount_value: parseNumberInput(draft.discount_value) ?? 0,
    tax_percent: parseNumberInput(draft.tax_percent) ?? 0,
  };
}
