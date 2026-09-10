// Rendering an exchange rate, and the sentence built around it.
//
// Ported from the helpers of the same names in
// `front/src/components/PaymentsPanel.tsx`, so the phone and the web say the
// same thing about the same payment.
//
// ── Why null is never 0 ──────────────────────────────────────────────────────
//
// A rate is `amount_received / amount_paid`. Divide by a zero payment and there
// is no rate at all — `src/lib/money.ts::divideTo` returns null rather than
// picking a number, and the server does the same. `effective_rate` is null for
// a second reason too: money that arrived in more than one currency has no
// single rate to state. Printing either as `0` would read as a real exchange
// rate of zero, which is a lie about the money. Both render as "—".

/** A rate to 6 dp, trailing zeros trimmed. Null and undefined are "—", not 0. */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  try {
    return rate.toLocaleString('en-SG', { maximumFractionDigits: 6 });
  } catch {
    // Hermes without full ICU. The rate is already quantised to 6 dp by
    // `divideTo`, so this only strips the trailing zeros `toFixed` adds — it
    // never does the rounding itself.
    return String(Number(rate.toFixed(6)));
  }
}

/**
 * "1 USD = 57.25 PHP", or null when there is nothing to state a rate between.
 *
 * A same-currency "rate" of 1 says nothing, so it is omitted rather than
 * printed.
 */
export function rateSentence(
  rate: number | null | undefined,
  from: string,
  to: string,
): string | null {
  if (rate === null || rate === undefined) return null;
  if (!from || !to) return null;
  if (from === to) return null;
  return `1 ${from} = ${formatRate(rate)} ${to}`;
}
