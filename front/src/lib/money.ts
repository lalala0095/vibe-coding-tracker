// Money math — must stay identical to back/services/invoice_service.py.
//
// InvoicingPlan.md §5 mandates Decimal arithmetic quantised to 2 dp with
// ROUND_HALF_UP. JavaScript has no Decimal, and the obvious substitutes are
// both wrong at the half cent: `(1.005).toFixed(2)` returns "1.00" because the
// binary double for 1.005 sits fractionally below the true half cent, which is
// the very trap §5 rule 1 calls out on the Python side.
//
// So the arithmetic here runs on exact scaled integers (BigInt), parsed from
// the decimal *string* form of each input — the JS equivalent of the backend's
// `Decimal(str(value))`. Only the final result is converted back to a number.

// A decimal value: m / 10^s, held exactly.
interface Dec {
  m: bigint;
  s: number;
}

const ZERO: Dec = { m: 0n, s: 0 };

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

// Parse a decimal string, including exponent notation, exactly.
function parseDec(str: string): Dec {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str.trim());
  if (!match) return ZERO;

  const [, sign, intPart, fracPart = '', expPart] = match;
  const digits = (intPart ?? '') + fracPart;
  if (digits === '') return ZERO;

  let m = BigInt(digits);
  if (sign === '-') m = -m;

  let s = fracPart.length - (expPart ? Number(expPart) : 0);
  if (s < 0) {
    m *= pow10(-s);
    s = 0;
  }
  return { m, s };
}

// The counterpart of the backend's `_to_decimal`: string route, null-safe,
// unparseable values become zero.
function toDec(value: number | string | null | undefined): Dec {
  if (value === null || value === undefined) return ZERO;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ZERO;
    // String(value) is the shortest round-tripping decimal form — the same
    // literal a human typed, which is exactly what Decimal(str(x)) receives.
    return parseDec(String(value));
  }
  return parseDec(value);
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.m * pow10(s - a.s), b.m * pow10(s - b.s), s];
}

function addDec(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return { m: x + y, s };
}

function subDec(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return { m: x - y, s };
}

function mulDec(a: Dec, b: Dec): Dec {
  return { m: a.m * b.m, s: a.s + b.s };
}

// Exact division by 100 — a scale shift, never a floating-point divide.
function div100(a: Dec): Dec {
  return { m: a.m, s: a.s + 2 };
}

// Quantise to `dp` places, ties away from zero — Python's ROUND_HALF_UP.
function quantizeTo(d: Dec, dp: number): Dec {
  if (d.s <= dp) return { m: d.m * pow10(dp - d.s), s: dp };

  const drop = pow10(d.s - dp);
  const negative = d.m < 0n;
  const abs = negative ? -d.m : d.m;
  const q = abs / drop;
  const remainder = abs % drop;
  const rounded = remainder * 2n >= drop ? q + 1n : q;

  return { m: negative ? -rounded : rounded, s: dp };
}

// Quantise to 2 dp — the money case, and every existing caller.
function quantize(d: Dec): Dec {
  return quantizeTo(d, 2);
}

/**
 * `a / b`, quantised to `dp` places, ties away from zero.
 *
 * Division is the one operation the scaled-integer representation cannot do
 * exactly, so it is done once at the requested precision rather than left to
 * float division: `Number(a) / Number(b)` would reintroduce exactly the binary
 * error this whole module exists to avoid.
 *
 * Returns null when the divisor is zero — a caller has to decide what no rate
 * at all should read as, and it is never 0.
 */
function divideTo(a: Dec, b: Dec, dp: number): Dec | null {
  if (b.m === 0n) return null;
  // a/b scaled by 10^dp = (a.m · 10^b.s · 10^dp) / (b.m · 10^a.s)
  const numerator = a.m * pow10(b.s) * pow10(dp);
  const denominator = b.m * pow10(a.s);

  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const q = absNum / absDen;
  const remainder = absNum % absDen;
  const rounded = remainder * 2n >= absDen ? q + 1n : q;

  return { m: negative ? -rounded : rounded, s: dp };
}

function decToNumber(d: Dec): number {
  return Number(d.m) / Number(pow10(d.s));
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Round to 2 dp, ROUND_HALF_UP. Mirrors `to_money`. */
export function roundMoney(value: number | string | null | undefined): number {
  return decToNumber(quantize(toDec(value)));
}

/** Round hours to 2 dp, ROUND_HALF_UP. Mirrors `round_hours`. */
export function roundHours(value: number | string | null | undefined): number {
  return decToNumber(quantize(toDec(value)));
}

/**
 * `hours × rate`, quantised to 2 dp. Mirrors `compute_line_amount`.
 *
 * Like the backend helper, hours are NOT pre-quantised here — `computeMoney`
 * is the path that quantises hours first, and it is the one invoices go
 * through. Zero-hour and zero-rate lines are legitimate and contribute 0.
 */
export function computeLineAmount(
  hours: number | null | undefined,
  rate: number | null | undefined
): number {
  return decToNumber(quantize(mulDec(toDec(hours), toDec(rate))));
}

export type DiscountType = 'percent' | 'amount' | null;

export interface MoneyTotals<T> {
  lines: T[];
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
}

/**
 * Recompute every monetary figure on an invoice. Mirrors `compute_money`.
 *
 * Each line is quantised to 2 dp *before* being added to the subtotal (§5 rule
 * 2) — summing at full precision and rounding once would make the stored
 * per-line amounts fail to re-add to the stored subtotal.
 *
 * A discount larger than the subtotal is left literal, producing a negative
 * total (§5 rule 3). Callers warn; nothing here clamps.
 */
export function computeMoney<T extends { hours: number; rate: number; amount: number }>(
  lines: T[],
  discountType: DiscountType = null,
  discountValue: number | null = null,
  taxPercent: number | null = null
): MoneyTotals<T> {
  const computedLines: T[] = [];
  let subtotal: Dec = ZERO;

  for (const line of lines) {
    const hours = quantize(toDec(line.hours));
    const rate = toDec(line.rate);          // rate is not quantised, as backend
    const amount = quantize(mulDec(hours, rate));

    computedLines.push({
      ...line,
      hours: decToNumber(hours),
      rate: decToNumber(rate),
      amount: decToNumber(amount),
    });

    subtotal = addDec(subtotal, amount);
  }

  subtotal = quantize(subtotal);

  let discount: Dec;
  if (discountType === 'percent') {
    discount = quantize(div100(mulDec(subtotal, toDec(discountValue))));
  } else if (discountType === 'amount') {
    discount = quantize(toDec(discountValue));
  } else {
    discount = { m: 0n, s: 2 };
  }

  const taxable = quantize(subDec(subtotal, discount));
  const tax = quantize(div100(mulDec(taxable, toDec(taxPercent))));
  const total = quantize(addDec(taxable, tax));

  return {
    lines: computedLines,
    subtotal: decToNumber(subtotal),
    discount_amount: decToNumber(discount),
    tax_amount: decToNumber(tax),
    total: decToNumber(total),
  };
}

export type HoursRoundingDirection = 'nearest' | 'up' | 'down';

/**
 * Snap `hours` onto a multiple of `increment` — e.g. billing in quarter hours.
 *
 * This has **no Python counterpart on purpose**. The server never rounds hours
 * to an increment; it only ever quantises them to 2 dp (`round_hours`). So the
 * absence of a mirror in `invoice_service.py` is deliberate and is *not* the
 * two implementations drifting apart, despite CLAUDE.md's sync requirement.
 * Increment rounding is a client-side input aid: it decides what number gets
 * typed into the invoice, and the server then treats that number as given.
 *
 * Direction:
 * - `'nearest'` — the nearest multiple. An exact half-step is resolved **away
 *   from zero**, the same tie rule `quantize` uses for ROUND_HALF_UP. On a
 *   0.25 increment that means 1.125 → 1.25 (never 1.00), and symmetrically
 *   -1.125 → -1.25.
 * - `'up'` — the smallest multiple that is >= hours (toward +∞, so -1.1 → -1.0)
 * - `'down'` — the largest multiple that is <= hours (toward -∞, so -1.1 → -1.25)
 *
 * Degenerate inputs are total, never thrown:
 * - increment null / 0 / negative / non-finite / unparseable → rounding is off,
 *   and this degrades to `roundHours`'s plain 2 dp behaviour.
 * - hours null / undefined / unparseable → 0.
 *
 * The whole computation runs on the exact scaled-integer path. Doing it in
 * floats silently overcharges a value that is *already* on the increment:
 * `Math.ceil(0.07 / 0.01) * 0.01` is 0.08, because 0.07 / 0.01 evaluates to
 * 7.000000000000001. Here an exact multiple is a fixed point in every
 * direction, at every increment.
 */
export function roundHoursToIncrement(
  hours: number | string | null | undefined,
  increment: number | string | null | undefined,
  direction: HoursRoundingDirection = 'nearest'
): number {
  const inc = toDec(increment);
  if (inc.m <= 0n) return roundHours(hours);

  // Align first: 9.500 and 0.25 arrive at different scales, exactly as
  // addDec/subDec have to reconcile.
  const [h, i, s] = align(toDec(hours), inc);

  // BigInt division truncates toward zero and the remainder carries the
  // dividend's sign, so every branch below works from the magnitude.
  const negative = h < 0n;
  const abs = negative ? -h : h;
  const q = abs / i;
  const remainder = abs % i;

  let steps: bigint;
  if (remainder === 0n) {
    steps = q; // already on the increment — must not move, in any direction
  } else if (direction === 'nearest') {
    steps = remainder * 2n >= i ? q + 1n : q;
  } else if (direction === 'up') {
    steps = negative ? q : q + 1n; // toward +∞
  } else {
    steps = negative ? q + 1n : q; // toward -∞
  }

  const m = negative ? -(steps * i) : steps * i;
  return decToNumber(quantize({ m, s }));
}

// ── Payments ──────────────────────────────────────────────────────────────────
// Mirrors `compute_payments` in back/services/invoice_service.py. The server
// recomputes all of this on write; this exists so the form can show the totals
// and the effective rate while they are still being typed.

/** The two amounts and the currency a payment landed in. */
export interface PaymentAmounts {
  amount_paid: number | null | undefined;
  amount_received: number | null | undefined;
  received_currency: string;
}

export interface ReceivedTotal {
  currency: string;
  amount: number;
}

export interface PaymentTotals<T> {
  payments: (T & { rate: number | null })[];
  amount_paid: number;
  received_totals: ReceivedTotal[];
  outstanding: number;
  effective_rate: number | null;
}

/**
 * Recompute an invoice's payment figures. Mirrors `compute_payments`.
 *
 * Received amounts total **per currency** — adding pesos to dollars would give a
 * number that means nothing — and `effective_rate` is reported only when there
 * is exactly one received currency to have a rate against.
 *
 * `outstanding` is not clamped: an overpayment reads negative, deliberately, so
 * a discrepancy shows rather than being rounded away into zero (§5 rule 4).
 */
export function computePayments<T extends PaymentAmounts>(
  payments: T[],
  total: number | null | undefined
): PaymentTotals<T> {
  const computed: (T & { rate: number | null })[] = [];
  let paidTotal: Dec = ZERO;
  // A Map, so the currencies come back in the order they were first paid.
  const receivedByCurrency = new Map<string, Dec>();

  for (const payment of payments) {
    const amountPaid = quantize(toDec(payment.amount_paid));
    const amountReceived = quantize(toDec(payment.amount_received));
    const currency = (payment.received_currency || '').trim();

    const rate = divideTo(amountReceived, amountPaid, 6);
    computed.push({
      ...payment,
      amount_paid: decToNumber(amountPaid),
      amount_received: decToNumber(amountReceived),
      rate: rate === null ? null : decToNumber(rate),
    });

    paidTotal = addDec(paidTotal, amountPaid);
    receivedByCurrency.set(
      currency,
      addDec(receivedByCurrency.get(currency) ?? ZERO, amountReceived)
    );
  }

  paidTotal = quantize(paidTotal);

  const received_totals: ReceivedTotal[] = [];
  for (const [currency, amount] of receivedByCurrency) {
    received_totals.push({ currency, amount: decToNumber(quantize(amount)) });
  }

  let effective_rate: number | null = null;
  if (receivedByCurrency.size === 1) {
    const only = quantize([...receivedByCurrency.values()][0]);
    const rate = divideTo(only, paidTotal, 6);
    effective_rate = rate === null ? null : decToNumber(rate);
  }

  return {
    payments: computed,
    amount_paid: decToNumber(paidTotal),
    received_totals,
    outstanding: decToNumber(quantize(subDec(toDec(total), paidTotal))),
    effective_rate,
  };
}

/** Display a money value, per §5. Falls back to a plain 2 dp figure. */
export function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-SG', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}
