// ─────────────────────────────────────────────────────────────────────────────
// COPY of front/src/lib/weeklySummary.ts. Everything below is byte-identical:
//
//   diff <(tail -n +11 src/lib/weeklySummary.ts) ../front/src/lib/weeklySummary.ts
//
// Copied, not ported, for the reason its own header gives: `resolveRate` is a
// port of back/services/rate_service.py, and a SECOND port of the same chain is
// exactly how the phone and the web start quoting different money for the same
// week. The `../types` and `./money` imports below resolve here unchanged.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// What a week of tracked time is worth.
//
// ── Where the hours come from, and why not from trackers ─────────────────────
//
// A tracker is a grouping. It has a span, but no project and therefore no rate:
// `Tracker` carries `TrackerTaskRef[]`, which holds names for display and no
// IDs to resolve a rate through. `back/routers/trackers.py:bill_tracker` says
// this outright — "a tracker on its own is a grouping and carries no billable
// time; only the `sessions` collection feeds the invoice preview."
//
// So every figure below is derived from time entries. That means a tracker you
// stopped but never billed contributes nothing here, which would be a silent
// undercount of exactly the hours you were trying to see. `unbilled` on each
// week exists to say so out loud rather than let the total quietly read low.
//
// ── Which rate ───────────────────────────────────────────────────────────────
//
// `resolveRate` is a port of `back/services/rate_service.py:resolve_rate`,
// minus the per-line override (a time entry has no rate field — a rate is only
// attached when a line is built onto an invoice). The chain and its meaning are
// the same, and so is the distinction the whole Clients & Projects screen is
// built around: `null` means "inherit", `0` means "bill nothing". They are not
// the same answer and must not collapse into one here.
//
// ── This is an estimate, not an invoice ──────────────────────────────────────
//
// It is `hours × rate` and nothing else. A real invoice can carry a per-line
// rate override, a discount and tax, none of which exist yet at this point, so
// the figure here and the figure on the eventual invoice are allowed to differ.
// The pane says this; the arithmetic below cannot.
//
// ── Currencies do not add up ─────────────────────────────────────────────────
//
// Each client has its own `currency` and there is no exchange rate anywhere in
// this system. A week billed to a USD client and a PHP client has no single
// money total, so `totals` is a list with one entry per currency and never a
// blended scalar — the same call `computePayments` already makes when it
// returns a null `effective_rate` for money that arrived in more than one
// currency. Hours, being a unit, do add up and stay a single number.
// ─────────────────────────────────────────────────────────────────────────────

import { computeLineAmount, roundHours, roundMoney } from './money';
import { addDays, dayOf, weekEndOf, weekHeading, weekRangeLabel, weekStartOf } from './week';
import type { Client, InvoiceSettings, Project, Session, Tracker } from '../types';

// ── Rates ─────────────────────────────────────────────────────────────────────

/** Which level of the chain actually supplied the rate. */
export type RateSource = 'project' | 'client' | 'settings' | 'none';

export interface ResolvedRate {
  rate: number;
  source: RateSource;
  currency: string;
}

export const RATE_SOURCE_LABEL: Record<RateSource, string> = {
  project: 'Project rate',
  client: 'Client default',
  settings: 'Invoice settings',
  none: 'No rate set',
};

/**
 * The hourly rate and currency in force for a project.
 *
 * Mirrors `resolve_rate` / `resolve_currency`: project → client → invoice
 * settings → 0. `source` is carried alongside because a bare figure cannot
 * answer "and where is that set?", which is the question anyone reading an
 * unexpected total asks next.
 *
 * A missing project or client is treated as "no rate set at that level", never
 * as zero — the server does the same with a missing document.
 */
export function resolveRate(
  project: Project | null | undefined,
  client: Client | null | undefined,
  settings: InvoiceSettings | null | undefined
): ResolvedRate {
  const currency = client?.currency || settings?.default_currency || 'USD';

  // Every test below is `!== null`, never truthiness: `0` is a real rate — "bill
  // nothing" — and a truthy test would fall through it to the next level and
  // quietly bill the client default instead.
  const projectRate = project?.rate ?? null;
  if (projectRate !== null) return { rate: projectRate, source: 'project', currency };

  const clientRate = client?.default_rate ?? null;
  if (clientRate !== null) return { rate: clientRate, source: 'client', currency };

  // `?? null` rather than `settings ? settings.default_rate : null`: the type
  // says `default_rate` is always a number, but the server builds settings with
  // `data.get(key, default)` over documents written before a field existed, so
  // an older one can arrive with the key simply absent. Reading that as
  // `undefined` and returning it would put `undefined` into every money figure
  // downstream. Both misses mean the same thing — the chain ran out, which is
  // `'none'`, and is not the same answer as a rate of zero.
  const settingsRate = settings?.default_rate ?? null;
  if (settingsRate !== null) return { rate: settingsRate, source: 'settings', currency };

  return { rate: 0, source: 'none', currency };
}

// ── Shapes ────────────────────────────────────────────────────────────────────

/** One currency's worth of a week. Never blended with another's. */
export interface CurrencyTotal {
  currency: string;
  /** Billable hours that resolved to this currency. */
  hours: number;
  amount: number;
}

/** A week's hours for one project, and what they convert to. */
export interface ProjectTotal {
  project_id: string;
  project_name: string;
  client_name: string;
  rate: number;
  rate_source: RateSource;
  currency: string;
  /** Every hour logged, billable or not. */
  hours: number;
  billable_hours: number;
  amount: number;
  entry_count: number;
}

/** Trackers stopped in a week that never became time entries. */
export interface UnbilledTrackers {
  count: number;
  /**
   * Their elapsed spans, added up. A warning figure, not a billed one — a
   * tracker whose end precedes its start (which nothing forbids) contributes
   * 0 here rather than subtracting from the others.
   */
  hours: number;
}

export interface WeekSummary {
  /** The Monday, `YYYY-MM-DD`. Unique, and the key for React. */
  key: string;
  start: string;
  end: string;
  /** `This week`, `Last week`, or `1 – 7 Sep 2026`. */
  heading: string;
  /** Always the date range, for the line under the heading. */
  range: string;
  hours: number;
  billable_hours: number;
  non_billable_hours: number;
  entry_count: number;
  totals: CurrencyTotal[];
  projects: ProjectTotal[];
  unbilled: UnbilledTrackers;
}

export interface WeeklySummaryInput {
  sessions: Session[];
  trackers: Tracker[];
  projects: Project[];
  clients: Client[];
  /** Null when the settings call failed — the chain then stops at the client. */
  settings: InvoiceSettings | null;
  /** Mondays to report on, newest first. See `recentWeekStarts`. */
  weekStarts: string[];
}

// ── Accumulation ──────────────────────────────────────────────────────────────
//
// Every addend below has already been quantised to 2 dp, so re-quantising after
// each addition is exact: the double sum of two 2 dp values is off by ~1e-16
// relative, which is fourteen orders of magnitude below the half cent that
// `roundMoney` decides on. This reuses the sanctioned quantiser rather than
// introducing a third piece of money arithmetic — `money.ts` is a byte-identical
// twin of `mobile/src/lib/money.ts` and is deliberately not extended from here.

const addMoney = (a: number, b: number): number => roundMoney(a + b);
const addHours = (a: number, b: number): number => roundHours(a + b);

function byId<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map((rows ?? []).map((row) => [row.id, row]));
}

/** A tracker's elapsed hours, or null when it has not stopped or cannot be read. */
export function trackerSpanHours(tracker: Tracker): number | null {
  if (!tracker.end_time) return null;
  // Both ends carry `+08:00`, so this is a subtraction of two instants and no
  // timezone enters into it.
  const start = Date.parse(tracker.start_time);
  const end = Date.parse(tracker.end_time);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return roundHours((end - start) / 3_600_000);
}

/**
 * Bucket time entries into weeks and price them.
 *
 * Weeks with nothing in them are kept, in the order `weekStarts` gave them: a
 * quiet week is a real answer, and dropping it would make the list look denser
 * than the month actually was.
 *
 * Entries whose week is not in `weekStarts` are ignored rather than folded into
 * the nearest one — the caller decided the window and this must not widen it.
 */
export function summariseWeeks({
  sessions,
  trackers,
  projects,
  clients,
  settings,
  weekStarts,
}: WeeklySummaryInput): WeekSummary[] {
  const projectById = byId(projects);
  const clientById = byId(clients);

  // Working buckets, one per requested Monday.
  interface Bucket {
    hours: number;
    billable_hours: number;
    non_billable_hours: number;
    entry_count: number;
    byCurrency: Map<string, CurrencyTotal>;
    byProject: Map<string, ProjectTotal>;
    unbilled: UnbilledTrackers;
  }

  const buckets = new Map<string, Bucket>();
  for (const monday of weekStarts) {
    buckets.set(monday, {
      hours: 0,
      billable_hours: 0,
      non_billable_hours: 0,
      entry_count: 0,
      byCurrency: new Map(),
      byProject: new Map(),
      unbilled: { count: 0, hours: 0 },
    });
  }

  for (const session of sessions ?? []) {
    const day = dayOf(session.start_time);
    if (day === null) continue;
    const monday = weekStartOf(day);
    if (monday === null) continue;
    const bucket = buckets.get(monday);
    if (!bucket) continue;

    const project = projectById.get(session.project_id) ?? null;
    const client = clientById.get(session.client_id) ?? null;
    const { rate, source, currency } = resolveRate(project, client, settings);

    // Quantise the entry's hours before they are multiplied or summed — the
    // same order `computeMoney` uses when it builds an invoice line.
    const hours = roundHours(session.effective_hours);
    const billable = session.billable !== false;
    const amount = billable ? computeLineAmount(hours, rate) : 0;

    bucket.hours = addHours(bucket.hours, hours);
    bucket.entry_count += 1;
    if (billable) {
      bucket.billable_hours = addHours(bucket.billable_hours, hours);
    } else {
      bucket.non_billable_hours = addHours(bucket.non_billable_hours, hours);
    }

    if (billable) {
      const running = bucket.byCurrency.get(currency) ?? { currency, hours: 0, amount: 0 };
      running.hours = addHours(running.hours, hours);
      running.amount = addMoney(running.amount, amount);
      bucket.byCurrency.set(currency, running);
    }

    // Keyed by project id, but an entry whose project has since been deleted
    // still has its denormalised name on it and is worth showing under that
    // rather than being dropped from the breakdown its hours are inside.
    const key = session.project_id || `~${session.project_name}`;
    const row = bucket.byProject.get(key) ?? {
      project_id: session.project_id,
      project_name: session.project_name || 'Unknown project',
      client_name: session.client_name || 'Unknown client',
      rate,
      rate_source: source,
      currency,
      hours: 0,
      billable_hours: 0,
      amount: 0,
      entry_count: 0,
    };
    row.hours = addHours(row.hours, hours);
    if (billable) {
      row.billable_hours = addHours(row.billable_hours, hours);
      row.amount = addMoney(row.amount, amount);
    }
    row.entry_count += 1;
    bucket.byProject.set(key, row);
  }

  // Which trackers already have time entries. Taken from every loaded session,
  // not just the ones inside a requested week, so a tracker billed into an
  // entry that was later re-dated is not flagged as unbilled.
  const billed = new Set<string>();
  for (const session of sessions ?? []) {
    if (session.tracker_id) billed.add(session.tracker_id);
  }

  for (const tracker of trackers ?? []) {
    if (!tracker.end_time) continue;          // still running — not owed yet
    if (billed.has(tracker.id)) continue;
    const day = dayOf(tracker.start_time);
    if (day === null) continue;
    const monday = weekStartOf(day);
    if (monday === null) continue;
    const bucket = buckets.get(monday);
    if (!bucket) continue;

    const span = trackerSpanHours(tracker);
    bucket.unbilled.count += 1;
    bucket.unbilled.hours = addHours(bucket.unbilled.hours, span !== null && span > 0 ? span : 0);
  }

  return weekStarts.map((monday) => {
    const bucket = buckets.get(monday)!;
    const end = weekEndOf(monday) ?? addDays(monday, 6) ?? monday;
    return {
      key: monday,
      start: monday,
      end,
      heading: weekHeading(monday),
      range: weekRangeLabel(monday, end),
      hours: bucket.hours,
      billable_hours: bucket.billable_hours,
      non_billable_hours: bucket.non_billable_hours,
      entry_count: bucket.entry_count,
      totals: [...bucket.byCurrency.values()].sort((a, b) =>
        a.currency.localeCompare(b.currency)
      ),
      projects: [...bucket.byProject.values()].sort(
        (a, b) => b.hours - a.hours || a.project_name.localeCompare(b.project_name)
      ),
      unbilled: bucket.unbilled,
    };
  });
}

/**
 * Every week in the window, added up.
 *
 * Spelled out as its own interface rather than subtracted from `WeekSummary`
 * with `Omit`. An `Omit` would quietly adopt any field later added to a week,
 * and this function — which would not be computing it — would then fail to
 * compile somewhere far from the change that caused it. Naming the fields makes
 * that failure land here, where the fix is.
 *
 * No `projects` breakdown: a project's rate can differ week to week, so summing
 * one project across the window would blend rates that were never in force
 * together. The per-week breakdowns are the honest place for that.
 */
export interface WindowTotals {
  hours: number;
  billable_hours: number;
  non_billable_hours: number;
  entry_count: number;
  totals: CurrencyTotal[];
  unbilled: UnbilledTrackers;
}

export function totalAcross(weeks: WeekSummary[]): WindowTotals {
  const byCurrency = new Map<string, CurrencyTotal>();
  let hours = 0;
  let billable_hours = 0;
  let non_billable_hours = 0;
  let entry_count = 0;
  const unbilled: UnbilledTrackers = { count: 0, hours: 0 };

  for (const week of weeks ?? []) {
    hours = addHours(hours, week.hours);
    billable_hours = addHours(billable_hours, week.billable_hours);
    non_billable_hours = addHours(non_billable_hours, week.non_billable_hours);
    entry_count += week.entry_count;
    unbilled.count += week.unbilled.count;
    unbilled.hours = addHours(unbilled.hours, week.unbilled.hours);

    for (const total of week.totals) {
      const running = byCurrency.get(total.currency) ?? { currency: total.currency, hours: 0, amount: 0 };
      running.hours = addHours(running.hours, total.hours);
      running.amount = addMoney(running.amount, total.amount);
      byCurrency.set(total.currency, running);
    }
  }

  return {
    hours,
    billable_hours,
    non_billable_hours,
    entry_count,
    totals: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    unbilled,
  };
}

/**
 * The average of the weeks that had any hours in them.
 *
 * Empty weeks are excluded on purpose: averaging them in answers "how much do I
 * work per calendar week", which is not what anyone reads this for. Returns 0
 * when nothing was tracked at all.
 */
export function averageWeeklyHours(weeks: WeekSummary[]): number {
  const worked = (weeks ?? []).filter((week) => week.hours > 0);
  if (worked.length === 0) return 0;
  let total = 0;
  for (const week of worked) total = addHours(total, week.hours);
  return roundHours(total / worked.length);
}
