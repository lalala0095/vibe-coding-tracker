// ─────────────────────────────────────────────────────────────────────────────
// Tracker auto-naming
//
// The owner names nearly every tracker the same way — "2026-08-07 tasks" — so
// the name is generated from a stored template instead of retyped. The template
// lives in tracker settings; this file turns it into text.
//
// Two rules shape the implementation:
//
// 1. **Local time, never `toISOString`.** A tracker started at 00:30 SGT must be
//    named for that day, not for the UTC day before it. Every token is built
//    from the Date's local getters for exactly the reason `datetime.ts` avoids
//    `new Date(text)`.
//
// 2. **A default, not a constraint** (§ no locking). The rendered name pre-fills
//    the title field and is editable from that moment on. Nothing re-renders it
//    behind the user, and a title they typed is never overwritten.
// ─────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/** One substitution, with the example the settings page shows beside it. */
export interface TrackerNameToken {
  token: string;
  label: string;
  render: (d: Date) => string;
}

// Written out by hand rather than through `toLocaleDateString` so the result
// does not change with the browser's locale — two machines must produce the
// same tracker name from the same template.
export const TRACKER_NAME_TOKENS: TrackerNameToken[] = [
  { token: 'date',          label: "Today's date",   render: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` },
  { token: 'date_short',    label: 'Readable date',  render: (d) => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}` },
  { token: 'day',           label: 'Day of month',   render: (d) => pad(d.getDate()) },
  { token: 'month',         label: 'Month number',   render: (d) => pad(d.getMonth() + 1) },
  { token: 'month_name',    label: 'Month name',     render: (d) => MONTHS[d.getMonth()] },
  { token: 'month_short',   label: 'Month, short',   render: (d) => MONTHS[d.getMonth()].slice(0, 3) },
  { token: 'year',          label: 'Year',           render: (d) => String(d.getFullYear()) },
  { token: 'weekday',       label: 'Weekday',        render: (d) => WEEKDAYS[d.getDay()] },
  { token: 'weekday_short', label: 'Weekday, short', render: (d) => WEEKDAYS[d.getDay()].slice(0, 3) },
  { token: 'time',          label: 'Time, 24-hour',  render: (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}` },
];

/**
 * The token names the backend also accepts.
 *
 * `back/routers/settings.py` keeps its own copy and rejects a template naming
 * anything outside it. The two lists must stay in step — a token added here and
 * not there is refused on save; one added there and not here renders as its own
 * literal braces in the tracker's title.
 */
export const TRACKER_NAME_TOKEN_NAMES: string[] = TRACKER_NAME_TOKENS.map((t) => t.token);

const TOKEN_PATTERN = /\{([a-z_]+)\}/g;

/**
 * Render a tracker-name template.
 *
 * @param template Text with `{token}` placeholders, e.g. "{date} tasks".
 * @param at       The moment to name for — the tracker's start time when there
 *                 is one, so a backdated tracker is named for its own day.
 *                 Defaults to now.
 * @returns The rendered name, trimmed. An unknown `{token}` is left exactly as
 *          written rather than blanked: a settings document saved before a
 *          token was renamed should read as obviously wrong, not silently lose
 *          part of the name.
 */
export function renderTrackerName(template: string, at: Date = new Date()): string {
  if (!template) return '';
  return template
    .replace(TOKEN_PATTERN, (whole, name: string) => {
      const token = TRACKER_NAME_TOKENS.find((t) => t.token === name);
      return token ? token.render(at) : whole;
    })
    .trim();
}

/**
 * Names for a template, as the settings page previews it.
 *
 * Split out so the preview and the real prefill can never drift — the preview
 * is the same call the tracker form makes.
 */
export function previewTrackerName(template: string, at: Date = new Date()): string {
  return renderTrackerName(template, at);
}

/** The `{token}` names used by a template, including ones nothing recognises. */
export function tokensUsed(template: string): string[] {
  const found: string[] = [];
  for (const match of (template || '').matchAll(TOKEN_PATTERN)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/** The `{token}` names a template uses that nothing will substitute. */
export function unknownTokens(template: string): string[] {
  return tokensUsed(template).filter((name) => !TRACKER_NAME_TOKEN_NAMES.includes(name));
}
