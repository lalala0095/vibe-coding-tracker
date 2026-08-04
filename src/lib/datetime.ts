// ─────────────────────────────────────────────────────────────────────────────
// Flexible date/time parsing
//
// A `datetime-local` input only accepts "YYYY-MM-DDTHH:mm", so a timestamp
// copied out of a spreadsheet — "7/13/2026 12:29:32" is what Google Sheets puts
// on the clipboard — cannot simply be pasted into one. Everything here exists
// to turn whatever was copied into that shape.
//
// Deliberately not `new Date(text)`: it reads bare dates as UTC and shifts them
// by a day, and its handling of slash formats varies by browser. The explicit
// patterns below are tried first and only genuinely unrecognised text falls
// through to the engine's own parser.
// ─────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** Assemble a datetime-local value, rejecting impossible components. */
function build(year: number, month: number, day: number, hour: number, minute: number): string | null {
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/** Expand a two-digit year the way spreadsheets do: 26 → 2026, 87 → 1987. */
function expandYear(year: number): number {
  if (year >= 100) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

/** Fold a 12-hour clock reading into 24-hour, given an am/pm marker. */
function applyMeridiem(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  const isPM = meridiem.toLowerCase().startsWith('p');
  if (isPM) return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour;
}

// "2026-07-13", "2026-07-13T12:29", "2026-07-13 12:29:32.5+08:00"
const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?/;

// "7/13/2026 12:29:32 PM", "13.7.26 12:29", "7/13/2026"
const SLASHED =
  /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?)?\s*([AaPp]\.?[Mm]\.?)?$/;

/**
 * Parse a pasted or typed timestamp into a `datetime-local` value.
 *
 * Accepts ISO-8601, the US "M/D/YYYY h:mm:ss" that Google Sheets copies, the
 * day-first "D/M/YYYY" variant, and dates with no time at all (which land at
 * midnight). Seconds are read but dropped — the input has no second field.
 *
 * Month/day order is decided per value: "13/7/2026" can only be day-first, so
 * it is read that way, while an ambiguous "7/6/2026" is read month-first to
 * match the spreadsheet default.
 *
 * @param text Raw clipboard or typed text.
 * @returns "YYYY-MM-DDTHH:mm", or null when the text is not a timestamp.
 */
export function parseFlexibleDateTime(text: string): string | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  const iso = ISO.exec(trimmed);
  if (iso) {
    const [, y, mo, d, h, mi] = iso;
    return build(Number(y), Number(mo), Number(d), Number(h ?? 0), Number(mi ?? 0));
  }

  const slashed = SLASHED.exec(trimmed);
  if (slashed) {
    const [, first, second, year, h, mi, meridiem] = slashed;
    const a = Number(first);
    const b = Number(second);
    // Only a value above 12 settles the order; anything else follows the
    // month-first convention the source spreadsheet was written in.
    const dayFirst = a > 12 && b <= 12;
    const month = dayFirst ? b : a;
    const day = dayFirst ? a : b;
    const hour = applyMeridiem(Number(h ?? 0), meridiem);
    return build(expandYear(Number(year)), month, day, hour, Number(mi ?? 0));
  }

  // Last resort — catches things like "Jul 13, 2026 12:29". Read through the
  // local-time getters, never toISOString, so the date cannot shift a day.
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return build(
    parsed.getFullYear(),
    parsed.getMonth() + 1,
    parsed.getDate(),
    parsed.getHours(),
    parsed.getMinutes()
  );
}

/**
 * Render a `datetime-local` value back as readable text, for confirming a paste.
 *
 * Formatted by hand from the string's own components — passing it through
 * `new Date` only to display it would reintroduce the timezone shift the parser
 * avoids.
 */
export function describeDateTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
  if (!match) return '';
  const [, y, mo, d, h, mi] = match;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(mo) - 1] ?? mo} ${y}, ${h}:${mi}`;
}
