// Singapore time, the only timezone this system has.
//
// Every timestamp in this app — server-written or client-written — is an
// ISO-8601 string carrying a `+08:00` offset. `back/routers/*.py` writes them
// with `datetime.now(tz=SGT).isoformat()`; the web writes them by appending the
// literal `+08:00` to a `datetime-local` value (`front/src/components/
// TimeEntryForm.tsx:26`, `front/src/pages/TrackersPage.tsx:53`); and every
// display path on the web passes `timeZone: 'Asia/Singapore'`.
//
// ── The rule this file exists to enforce ──────────────────────────────────────
//
// **No file in this app may call `.toISOString()` on a user-facing timestamp.**
//
// `toISOString()` returns UTC with a `Z`. On a phone in Singapore between
// midnight and 08:00 that is *the previous day*, and a wrong date here does not
// stay here — it flows into a time entry, then into an invoice's period and its
// line date ranges. `front/src/pages/TrackersPage.tsx:1264` has this defect
// today, which is precisely why it is spelled out rather than assumed.
//
// ── Why the offset is hardcoded rather than computed ──────────────────────────
//
// Singapore has observed a fixed UTC+8 with no daylight saving since 1982, and
// no DST at all since 1935. There is no transition to get wrong. Shifting by a
// constant and reading the UTC getters is therefore exact, and it avoids
// depending on `Intl.DateTimeFormat` with a `timeZone` option, whose support on
// Hermes varies with how the Android build was configured. Fewer moving parts,
// and correct on a phone that is not in Singapore.

const SGT_OFFSET_MINUTES = 8 * 60;
const SGT_OFFSET_MS = SGT_OFFSET_MINUTES * 60 * 1000;
const SGT_SUFFIX = '+08:00';

export interface SgtFields {
  year: number;
  month: number;   // 1-12, not the 0-11 the Date getters use
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * The Singapore wall-clock fields of an instant.
 *
 * Shift the instant forward by the offset and read the *UTC* getters: the
 * result is what a clock in Singapore reads. Reading the local getters instead
 * would give whatever the phone's timezone happens to be.
 */
export function sgtFields(at: Date): SgtFields {
  const shifted = new Date(at.getTime() + SGT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** An instant as the wire format: `2026-08-14T21:05:33+08:00`. */
export function toSgtIso(at: Date): string {
  const f = sgtFields(at);
  return (
    `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}` +
    `T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}${SGT_SUFFIX}`
  );
}

/** Now, in the wire format. The replacement for `new Date().toISOString()`. */
export function nowSgt(): string {
  return toSgtIso(new Date());
}

/** Today's Singapore date as `YYYY-MM-DD`. */
export function todaySgt(): string {
  return sgtDay(new Date());
}

/** The Singapore calendar date of an instant, as `YYYY-MM-DD`. */
export function sgtDay(at: Date): string {
  const f = sgtFields(at);
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`;
}

/**
 * Build a wire timestamp from Singapore wall-clock fields.
 *
 * This is what a date/time picker feeds: the user chose "9:30 on the 14th",
 * meaning 9:30 in Singapore, exactly as typing it into the web's
 * `datetime-local` box would. Seconds default to 0, matching the web, whose
 * inputs have no seconds component.
 */
export function fromSgtFields(fields: Partial<SgtFields> & Pick<SgtFields, 'year' | 'month' | 'day'>): string {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = fields;
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)}` +
    `T${pad(hour)}:${pad(minute)}:${pad(second)}${SGT_SUFFIX}`
  );
}

/**
 * Parse a stored timestamp into a `Date`.
 *
 * A bare date-time with no offset is read as Singapore time, not as the phone's
 * local time — which is what the ECMAScript spec would otherwise do, and would
 * silently shift every such value by however far the phone is from SGT. The
 * server always writes an offset, so this branch is defensive rather than
 * routine. Returns `null` on anything unparseable, so a bad string surfaces as
 * a visible gap rather than an `Invalid Date` propagating into arithmetic.
 */
export function parseSgt(iso: string | null | undefined): Date | null {
  if (!iso) return null;

  const trimmed = iso.trim();

  // A bare `YYYY-MM-DD` is a real shape in this system, not a malformed
  // timestamp: `due_date`, `period_start`/`period_end` and the `date_from`/
  // `date_to` query params are all date-only. It means Singapore midnight on
  // that day. Appending the offset alone would produce `2026-08-14+08:00`,
  // which parses as nothing at all — the date would silently read as null.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsedDay = new Date(`${trimmed}T00:00:00${SGT_SUFFIX}`);
    return Number.isNaN(parsedDay.getTime()) ? null : parsedDay;
  }

  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const candidate = hasOffset ? trimmed : `${trimmed}${SGT_SUFFIX}`;

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The Singapore calendar date of a stored timestamp — the key entries group by. */
export function sgtDayKey(iso: string | null | undefined): string | null {
  const at = parseSgt(iso);
  return at ? sgtDay(at) : null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** `Thu, 14 Aug 2026` — for a day heading. */
export function formatSgtDate(iso: string | null | undefined): string {
  const at = parseSgt(iso);
  if (!at) return '—';
  const f = sgtFields(at);
  // Weekday comes from the shifted instant for the same reason as everything
  // else here: the local getter would name the phone's day, not Singapore's.
  const weekday = WEEKDAYS[new Date(at.getTime() + SGT_OFFSET_MS).getUTCDay()];
  return `${weekday}, ${f.day} ${MONTHS[f.month - 1]} ${f.year}`;
}

/** `21:05` — 24-hour, matching the rest of the system. */
export function formatSgtTime(iso: string | null | undefined): string {
  const at = parseSgt(iso);
  if (!at) return '—';
  const f = sgtFields(at);
  return `${pad(f.hour)}:${pad(f.minute)}`;
}

/** `14 Aug 2026, 21:05`. */
export function formatSgtDateTime(iso: string | null | undefined): string {
  const at = parseSgt(iso);
  if (!at) return '—';
  const f = sgtFields(at);
  return `${f.day} ${MONTHS[f.month - 1]} ${f.year}, ${pad(f.hour)}:${pad(f.minute)}`;
}

/**
 * `02:14:37` — elapsed time for the ticking tracker card.
 *
 * A pure duration between two instants, so no timezone is involved at all. A
 * negative span (a start time in the future, which the user is free to enter —
 * nothing here blocks it) reads as `00:00:00` rather than as a negative clock.
 */
export function formatElapsed(fromIso: string | null | undefined, now: Date = new Date()): string {
  const start = parseSgt(fromIso);
  if (!start) return '—';

  const totalSeconds = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
