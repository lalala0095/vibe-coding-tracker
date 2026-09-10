// Summing hours for display, and nothing else.
//
// ── What this is NOT ──────────────────────────────────────────────────────────
//
// This is **not** an implementation of the money rules. `back/services/
// invoice_service.py` and `front/src/lib/money.ts` are the two copies of that
// arithmetic and they must stay in sync with each other; a third copy living on
// a phone would be a third thing to keep in step, and this app has no reason to
// own one. It builds no invoices, edits no rates, and computes no amounts.
//
// Everything billable stays on the server. `effective_hours` arrives already
// resolved and already rounded to 2 dp by `compute_effective_hours()` in
// `back/routers/sessions.py`; nothing here recomputes it.
//
// ── What this IS ──────────────────────────────────────────────────────────────
//
// A running total under a list, so a day's entries visibly add up. The only
// reason it is not `values.reduce((a, b) => a + b, 0)` is that binary floats
// render `12.299999999999999` under a column of clean two-decimal numbers.
// Summing as hundredths keeps the total looking like the figures above it.

/** Hours as an exact count of hundredths. Inputs are already 2 dp from the server. */
function toHundredths(hours: number | null | undefined): number {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return 0;
  return Math.round(hours * 100);
}

/**
 * Total a list of hours, for display.
 *
 * Negative values are summed as given rather than clamped — the same reasoning
 * as the unclamped over-discount on the server: showing a total that disagrees
 * with the rows above it would hide a real discrepancy.
 */
export function sumHours(values: Array<number | null | undefined>): number {
  const hundredths = values.reduce<number>((total, value) => total + toHundredths(value), 0);
  return hundredths / 100;
}

/** `3.25` → `"3.25"`. Always two decimals, so a column of totals lines up. */
export function formatHours(hours: number | null | undefined): string {
  return (toHundredths(hours) / 100).toFixed(2);
}

/** `3.25` → `"3.25 h"`, for a label that stands on its own. */
export function formatHoursLabel(hours: number | null | undefined): string {
  return `${formatHours(hours)} h`;
}
