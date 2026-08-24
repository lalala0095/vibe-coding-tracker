// ─────────────────────────────────────────────────────────────────────────────
// Weeks, in Singapore time, done as calendar arithmetic on bare dates.
//
// A week here runs Monday → Sunday, and every function in this file takes and
// returns a bare `YYYY-MM-DD` — never a timestamp, never a `Date` that escapes.
//
// ── Why bare dates, and why they are already SGT ─────────────────────────────
//
// `back/routers/sessions.py:_local_date` decides which day a time entry falls
// on with `start_time[:10]` — a raw string slice, no parsing at all. That works
// because every timestamp this system writes carries `+08:00`, so the first ten
// characters *are* the Singapore date. `date_from`/`date_to` filter on exactly
// that.
//
// Bucketing here therefore uses the same slice. Re-deriving the day with
// `new Date(start_time)` would read it in the browser's zone instead, and a
// laptop in London would file Monday 07:00 SGT under Sunday — the client and
// the server would disagree about which week an entry is in, while the server's
// own range filter had already trimmed the list. Slicing is not a shortcut; it
// is the only way to agree with the filter that produced the data.
//
// ── Why `Date.UTC` is safe below ─────────────────────────────────────────────
//
// Once a value is a bare date it has no instant behind it, so "add seven days"
// is pure calendar work. `Date.UTC` is used as an arithmetic engine only: every
// value goes in through `Date.UTC` and comes back out through `getUTC*`, so no
// local zone is ever consulted and nothing can shift by a day. This is not the
// `toISOString()` hazard CLAUDE.md warns about — that one is about formatting a
// real instant, which nothing here holds.
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Singapore is UTC+8 and has had no DST since 1935, so this is a constant. */
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** A bare date as a UTC-midnight epoch, or null when it is not one. */
function dayToUtc(day: string): number | null {
  const match = DAY.exec((day || '').trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const at = Date.UTC(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(at)) return null;
  // Round-trip guard: `Date.UTC(2026, 1, 30)` happily yields 2 March. A date
  // that does not survive the trip was never a real day.
  const back = utcToDay(at);
  return back === `${y}-${m}-${d}` ? at : null;
}

/** A UTC-midnight epoch back as a bare date. */
function utcToDay(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whether a string is a usable bare date. */
export function isDay(day: string | null | undefined): boolean {
  return day != null && dayToUtc(day) !== null;
}

/** The SGT date of a stored timestamp — the same slice the server filters on. */
export function dayOf(timestamp: string | null | undefined): string | null {
  const slice = (timestamp || '').slice(0, 10);
  return isDay(slice) ? slice : null;
}

/** Today's date in Singapore, regardless of where the browser is. */
export function todaySgt(): string {
  return utcToDay(Date.now() + SGT_OFFSET_MS);
}

/** `day` shifted by whole days. Negative goes backwards. */
export function addDays(day: string, count: number): string | null {
  const at = dayToUtc(day);
  return at === null ? null : utcToDay(at + count * MS_PER_DAY);
}

/**
 * The Monday of the week containing `day`.
 *
 * `getUTCDay()` is 0 for Sunday, so Sunday is six days *after* its Monday, not
 * one day before it. That off-by-one is the whole reason this is a function
 * rather than a subtraction at each call site.
 */
export function weekStartOf(day: string): string | null {
  const at = dayToUtc(day);
  if (at === null) return null;
  const dow = new Date(at).getUTCDay();
  const backToMonday = dow === 0 ? 6 : dow - 1;
  return utcToDay(at - backToMonday * MS_PER_DAY);
}

/** The Sunday of the week containing `day`. */
export function weekEndOf(day: string): string | null {
  const monday = weekStartOf(day);
  return monday === null ? null : addDays(monday, 6);
}

/**
 * The Mondays of the last `count` weeks, this week first.
 *
 * Weeks with no time entries in them are still listed — a quiet week is a
 * fact worth seeing, and dropping it would make the list silently uneven.
 */
export function recentWeekStarts(count: number, today: string = todaySgt()): string[] {
  const thisMonday = weekStartOf(today);
  if (thisMonday === null || count <= 0) return [];

  const starts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const monday = addDays(thisMonday, -7 * i);
    if (monday === null) break;
    starts.push(monday);
  }
  return starts;
}

/**
 * `1 – 7 Sep 2026`, collapsing whatever the two ends share.
 *
 * String work only: these are bare dates with no instant behind them, so there
 * is no timezone to get wrong and `toLocaleDateString` would only invite one.
 */
export function weekRangeLabel(start: string, end: string): string {
  const a = DAY.exec(start);
  const b = DAY.exec(end);
  if (!a || !b) return `${start} – ${end}`;

  const [, ay, am, ad] = a;
  const [, by, bm, bd] = b;
  const aMonth = MONTHS[Number(am) - 1] ?? am;
  const bMonth = MONTHS[Number(bm) - 1] ?? bm;

  if (ay !== by) return `${Number(ad)} ${aMonth} ${ay} – ${Number(bd)} ${bMonth} ${by}`;
  if (am !== bm) return `${Number(ad)} ${aMonth} – ${Number(bd)} ${bMonth} ${by}`;
  return `${Number(ad)} – ${Number(bd)} ${bMonth} ${by}`;
}

/**
 * `This week`, `Last week`, or the date range.
 *
 * The two relative labels are worth the special case: the current week is the
 * one being read most often, and "This week" answers at a glance what a date
 * range makes you work out.
 */
export function weekHeading(start: string, today: string = todaySgt()): string {
  const end = weekEndOf(start);
  const range = end === null ? start : weekRangeLabel(start, end);
  const thisMonday = weekStartOf(today);
  if (thisMonday === null) return range;
  if (start === thisMonday) return 'This week';
  if (start === addDays(thisMonday, -7)) return 'Last week';
  return range;
}
