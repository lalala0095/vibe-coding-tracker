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

// Quantise to 2 dp, ties away from zero — Python's ROUND_HALF_UP.
function quantize(d: Dec): Dec {
  if (d.s <= 2) return { m: d.m * pow10(2 - d.s), s: 2 };

  const drop = pow10(d.s - 2);
  const negative = d.m < 0n;
  const abs = negative ? -d.m : d.m;
  const q = abs / drop;
  const remainder = abs % drop;
  const rounded = remainder * 2n >= drop ? q + 1n : q;

  return { m: negative ? -rounded : rounded, s: 2 };
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
