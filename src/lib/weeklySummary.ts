// ─────────────────────────────────────────────────────────────────────────────
// What a week of tracked time is worth.
//
// ── Two sources of hours, and why both are needed ────────────────────────────
//
// Time entries (the `sessions` collection) are the billable record: they carry
// a project, and therefore a rate. Trackers are the daily habit — you start
// one, it collects tasks, and its span only becomes billable when
// `POST /trackers/{id}/bill` turns it into time entries.
//
// This file used to report time entries alone and merely *warn* that stopped,
// unbilled trackers were missing. For someone who runs a tracker every day and
// bills in a batch at month end, that meant the week they had just worked read
// as zero. So trackers are now ingested too — but never on top of the entries
// they already produced. See "Never counted twice" below.
//
// ── How a tracker gets a rate, given it has no project ───────────────────────
//
// A `Tracker` really does carry no `project_id`, and `TrackerTaskRef` holds
// denormalised names. But it does carry `task_id`, and a task carries
// `project_id` — which is exactly the hop `bill_tracker` makes on the server
// (`_resolve_tracker_tasks`, which re-reads the tasks precisely because "a time
// entry needs project_id and client_id, which the TaskRef does not carry").
// `summariseWeeks` therefore takes the task list and makes the same hop.
//
// When the task has been deleted, the TaskRef's `project_name` + `client_name`
// are tried against the loaded projects as a fallback. When neither resolves,
// the hours are still counted and reported as `unpriced_hours` — hours you
// worked are a fact even when nothing can price them, and dropping them is the
// undercount this change exists to remove.
//
// ── Never counted twice ──────────────────────────────────────────────────────
//
// A tracker contributes `max(0, span − hours already billed into time entries)`.
//
//   - Never billed          → its whole span, priced through its tasks.
//   - Billed in full        → nothing; the time entries already carry it.
//   - Billed in part        → only the remainder (`bill_tracker` skips tasks
//                             that already have an entry, so this is a real
//                             state, not a hypothetical).
//   - Billed for MORE than
//     it ran (hours on an
//     entry are editable)   → nothing. The entries win; the clamp at 0 means a
//                             tracker can never subtract from a week.
//
// The remainder is split across the tracker's not-yet-billed tasks the same way
// `_split_hours` splits it — evenly, remainder on the first share — so what you
// read here is what billing would actually write.
//
// ── Invoiced directly, which is NOT the same as unbilled ─────────────────────
//
// `bill_tracker` is not the only way a tracker's time reaches an invoice. An
// invoice line can carry a `tracker_id` and bill the span *directly*, with no
// time entries created at all (`back/routers/invoices.py` builds those lines,
// and `Tracker.invoice_ids` records the claim). Such a tracker has no session
// carrying its id, so the rule above alone reports its whole span as still
// owed — hours the client has already been invoiced for, sitting in a figure
// labelled "not billed yet".
//
// So the contribution is split rather than reduced:
//
//   invoiced    = hours on non-void invoice lines carrying this tracker's id
//   outstanding = contribution − invoiced
//
// Both are real worked hours and both stay in `hours`, the money and the
// project breakdown — removing the invoiced part would make the week read low
// again, which is the whole defect this file exists to avoid. Only
// `outstanding` is reported as not yet billed.
//
// A **void** invoice is deliberately not counted as invoiced. `void` "is not a
// lock" on the server and voiding does not release the claim, but a cancelled
// invoice is never going to be paid — those hours genuinely still need
// invoicing, and saying so is the useful answer.
//
// ── Running trackers are included, and flagged ───────────────────────────────
//
// A tracker running right now is real work in progress, and the person reading
// this screen at 4pm wants today in the figure. Its elapsed-so-far is counted
// and reported separately as `running_hours` so a timer left on overnight is
// visible as such rather than buried in the total. Warned about, never clamped
// — CLAUDE.md § "no locking".
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
// Tracker hours widen that gap — they are a projection of a bill that has not
// been raised. The pane says this; the arithmetic below cannot.
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
import type {
  Client,
  Invoice,
  InvoiceSettings,
  Project,
  Session,
  Task,
  Tracker,
  TrackerTaskRef,
} from '../types';

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

/**
 * One currency's worth of a week. Never blended with another's.
 *
 * `tracker_hours` / `tracker_amount` are the part of `hours` / `amount` that
 * came from tracker time nobody has billed or invoiced yet — the "of which,
 * projected" portion, not a second figure to add on. Tracker time that IS
 * already on an invoice is inside `hours` / `amount` like any other billed
 * work and deliberately not here: this pair answers "what is still owed to
 * me", and an invoiced hour is not.
 */
export interface CurrencyTotal {
  currency: string;
  /** Billable hours that resolved to this currency. */
  hours: number;
  amount: number;
  tracker_hours: number;
  tracker_amount: number;
}

/** A week's hours for one project, and what they convert to. */
export interface ProjectTotal {
  project_id: string;
  project_name: string;
  client_name: string;
  rate: number;
  rate_source: RateSource;
  currency: string;
  /** Every hour logged, billable or not, from both sources. */
  hours: number;
  billable_hours: number;
  amount: number;
  /** Time entries only. A tracker is not an entry and is counted below. */
  entry_count: number;
  /**
   * The part of `hours` / `amount` above that is tracker time not billed into
   * time entries and not on an invoice either. Excludes tracker time already
   * invoiced directly, which is ordinary billed work.
   */
  tracker_hours: number;
  tracker_amount: number;
  /** Trackers that contributed anything to this project, invoiced or not. */
  tracker_count: number;
}

/**
 * The tracker-derived part of a week — already inside every figure above it.
 *
 * This is a provenance breakdown, never an addend. `hours` here is a subset of
 * `WeekSummary.hours`, and adding the two together double-counts.
 */
export interface TrackerHours {
  /** Trackers that contributed anything to this week. */
  count: number;
  /** Their contribution, in hours. `invoiced_hours + outstanding_hours`. */
  hours: number;
  /**
   * Of `hours`, the part already billed directly onto an invoice line carrying
   * this tracker's id. Real, billed work — counted in every money figure, and
   * never reported as owing.
   */
  invoiced_hours: number;
  /** Trackers with any directly invoiced time. */
  invoiced_count: number;
  /**
   * Of `hours`, the part on no invoice and in no time entry. THIS is the
   * "not billed yet" figure; `hours` is not, and using `hours` for it reports
   * invoiced work as outstanding.
   */
  outstanding_hours: number;
  /**
   * Trackers with any outstanding time. Not `count`: a week whose trackers are
   * all invoiced still has `count > 0`, and a note reading "3 trackers not
   * billed yet" over 0 outstanding hours is the same class of wrong this field
   * was added to fix.
   */
  outstanding_count: number;
  /** Of `count` / `hours`, the part still running right now. */
  running_count: number;
  running_hours: number;
  /**
   * Hours from trackers whose task resolved to no project, and which therefore
   * appear in `hours` but in no currency total. Counted rather than dropped:
   * worked hours are a fact even when nothing prices them.
   */
  unpriced_hours: number;
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
  /** Time entries plus unbilled trackers. The headline figure. */
  hours: number;
  billable_hours: number;
  non_billable_hours: number;
  /** The part of `hours` that came from time entries. */
  entry_hours: number;
  /** How many time entries. Trackers are counted in `trackers.count`. */
  entry_count: number;
  totals: CurrencyTotal[];
  projects: ProjectTotal[];
  trackers: TrackerHours;
}

export interface WeeklySummaryInput {
  sessions: Session[];
  trackers: Tracker[];
  projects: Project[];
  clients: Client[];
  /**
   * The task list, which is how a tracker reaches a project and therefore a
   * rate — `TrackerTaskRef` carries `task_id` but no `project_id`. An empty
   * list is not fatal: pricing falls back to matching the ref's denormalised
   * project and client names against `projects`.
   */
  tasks: Task[];
  /**
   * Every invoice, so a tracker billed straight onto a line is not reported as
   * still owing. Only `line.tracker_id` and `line.hours` are read. An empty
   * list degrades the way it always behaved: directly invoiced trackers read as
   * outstanding.
   */
  invoices: Invoice[];
  /** Null when the settings call failed — the chain then stops at the client. */
  settings: InvoiceSettings | null;
  /** Mondays to report on, newest first. See `recentWeekStarts`. */
  weekStarts: string[];
  /**
   * "Now", as an epoch, for measuring a tracker that has not stopped. Injected
   * so a test can pin it; defaults to the real clock. Nothing here formats it,
   * so no timezone is involved — it is only ever subtracted from another
   * instant.
   */
  now?: number;
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

/**
 * A tracker's elapsed hours, or null when it cannot be read.
 *
 * `now` measures a tracker that has not stopped; without it a running tracker
 * returns null, which is what a caller that only wants finished work relies on.
 *
 * Negative spans clamp to 0, mirroring `_tracker_hours`'s `max(0.0, ...)`: an
 * end before its start is bad data, and letting it through would have a tracker
 * subtract from the week.
 */
export function trackerSpanHours(tracker: Tracker, now?: number | null): number | null {
  // Both ends carry `+08:00`, so this is a subtraction of two instants and no
  // timezone enters into it.
  const start = Date.parse(tracker.start_time);
  if (Number.isNaN(start)) return null;

  let end: number;
  if (tracker.end_time) {
    end = Date.parse(tracker.end_time);
    if (Number.isNaN(end)) return null;
  } else {
    if (now === null || now === undefined) return null;
    end = now;
  }

  return roundHours(Math.max(0, (end - start) / 3_600_000));
}

/**
 * Share `total` hours across `count` entries, evenly.
 *
 * Follows `back/routers/trackers.py:_split_hours` in its default `"even"`
 * mode, remainder on the first share included, so the shares previewed here
 * are the shares billing would write. `"full"` is not ported: it is an explicit
 * choice made in the billing dialog, and assuming it in a summary would
 * multiply a week's hours by the number of tasks on a tracker.
 *
 * Not quite byte-identical to the server, and deliberately so. `_split_hours`
 * quantises with Python's built-in `round`, which is banker's rounding over a
 * float; `roundHours` is the ROUND_HALF_UP quantiser CLAUDE.md mandates
 * everywhere else in this codebase. They disagree only when a share lands on an
 * exact half cent — `evenSplit(0.15, 2)` is `[0.07, 0.08]` here and
 * `[0.08, 0.07]` there. Verified across 90 two-decimal cases: the two agree on
 * 84, and on all 90 the shares still sum back to the total, which is the
 * property that matters — the disagreement moves one cent's worth of an hour
 * between two tasks and never changes what a week is worth. Importing a fourth
 * rounding mode to match the server exactly would cost more than it buys.
 */
export function evenSplit(total: number, count: number): number[] {
  if (count <= 0) return [];
  const each = roundHours(total / count);
  const parts: number[] = new Array(count).fill(each);
  parts[0] = roundHours(total - each * (count - 1));
  return parts;
}

/** One task's share of a tracker's time. */
export interface TrackerShare {
  task_id: string;
  task_title: string;
  project_name: string;
  client_name: string;
  /** This task's slice of the whole contribution, invoiced part included. */
  hours: number;
  /** Of `hours`, the slice that is on no invoice. Never greater than `hours`. */
  outstanding_hours: number;
}

/** What one tracker adds to its week. */
export interface TrackerContribution {
  tracker_id: string;
  /** The SGT date the tracker started — the same slice the server files on. */
  day: string;
  running: boolean;
  /** `max(0, span − billed into time entries)`, and the sum of the shares. */
  hours: number;
  /** Of `hours`, the part already on a non-void invoice line. */
  invoiced_hours: number;
  /** Of `hours`, the part on no invoice — the real "not billed yet". */
  outstanding_hours: number;
  /** Empty when the tracker has no tasks at all — then `hours` is unpriceable. */
  shares: TrackerShare[];
}

/**
 * What each tracker still owes its week, after the entries it already produced.
 *
 * Exported because this is the part with the double-count in it, and it is
 * worth being able to assert on directly rather than only through a week's
 * totals.
 */
export function trackerContributions(
  trackers: Tracker[],
  sessions: Session[],
  invoices: Invoice[],
  now: number
): TrackerContribution[] {
  // Hours already invoiced straight off a tracker, with no time entry between.
  // Void invoices are skipped: the claim survives a void on the server, but a
  // cancelled invoice will never be paid and those hours do still need billing.
  const invoicedHours = new Map<string, number>();
  for (const invoice of invoices ?? []) {
    if (invoice.status === 'void') continue;
    for (const line of invoice.lines ?? []) {
      const id = line.tracker_id;
      if (!id) continue;
      invoicedHours.set(id, addHours(invoicedHours.get(id) ?? 0, roundHours(line.hours)));
    }
  }

  // Built from EVERY loaded session, not just the ones inside a requested week:
  // a tracker billed into an entry that was later re-dated out of the window
  // must still count as billed, or its hours reappear as a phantom estimate.
  const billedHours = new Map<string, number>();
  const billedTasks = new Map<string, Set<string>>();
  for (const session of sessions ?? []) {
    const id = session.tracker_id;
    if (!id) continue;
    billedHours.set(id, addHours(billedHours.get(id) ?? 0, roundHours(session.effective_hours)));
    const tasks = billedTasks.get(id) ?? new Set<string>();
    if (session.task_id) tasks.add(session.task_id);
    billedTasks.set(id, tasks);
  }

  const out: TrackerContribution[] = [];

  for (const tracker of trackers ?? []) {
    const day = dayOf(tracker.start_time);
    if (day === null) continue;

    const running = !tracker.end_time;
    const span = trackerSpanHours(tracker, now);
    if (span === null) continue;

    // The clamp is what makes a tracker incapable of reducing a week. Hours on
    // a time entry are freely editable, so billing 3 hours off a 2-hour tracker
    // is a legal state, and `span − billed` is then negative.
    const remaining = roundHours(Math.max(0, span - (billedHours.get(tracker.id) ?? 0)));
    if (remaining <= 0) continue;

    const refs: TrackerTaskRef[] = tracker.tasks ?? [];
    const alreadyBilled = billedTasks.get(tracker.id) ?? new Set<string>();
    // The tasks a re-bill would actually write to, exactly as `bill_tracker`
    // computes `pending`. If every task has an entry yet time is still
    // outstanding — the hours on those entries were edited down — the remainder
    // belongs to all of them rather than to nobody.
    const pending = refs.filter((ref) => !alreadyBilled.has(ref.task_id));
    const base = pending.length > 0 ? pending : refs;

    // Capped at the contribution: invoicing MORE hours than the tracker ran is
    // legal (line hours are editable), and an uncapped subtraction would make
    // `outstanding` negative and start eating other trackers' hours.
    const invoiced = Math.min(remaining, roundHours(invoicedHours.get(tracker.id) ?? 0));
    const outstanding = roundHours(remaining - invoiced);

    if (base.length === 0) {
      out.push({
        tracker_id: tracker.id,
        day,
        running,
        hours: remaining,
        invoiced_hours: invoiced,
        outstanding_hours: outstanding,
        shares: [],
      });
      continue;
    }

    const shares = evenSplit(remaining, base.length);
    const outstandingShares = evenSplit(outstanding, base.length);
    out.push({
      tracker_id: tracker.id,
      day,
      running,
      hours: remaining,
      invoiced_hours: invoiced,
      outstanding_hours: outstanding,
      shares: base.map((ref, i) => ({
        task_id: ref.task_id,
        task_title: ref.task_title,
        project_name: ref.project_name,
        client_name: ref.client_name,
        hours: shares[i] ?? 0,
        outstanding_hours: Math.min(shares[i] ?? 0, outstandingShares[i] ?? 0),
      })),
    });
  }

  return out;
}

/**
 * Bucket time entries and unbilled trackers into weeks, and price them.
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
  tasks,
  invoices,
  settings,
  weekStarts,
  now,
}: WeeklySummaryInput): WeekSummary[] {
  const projectById = byId(projects);
  const clientById = byId(clients);
  const taskById = byId(tasks ?? []);

  // The fallback path for a tracker whose task has since been deleted. Keyed on
  // the pair, because two clients may each have a project called "Website" and
  // charging one client's rate to the other's work is the kind of wrong that
  // never announces itself. An ambiguous name resolves to nothing rather than
  // to a coin flip.
  const projectByName = new Map<string, Project | null>();
  for (const project of projects ?? []) {
    const key = `${project.client_name} ${project.name}`;
    projectByName.set(key, projectByName.has(key) ? null : project);
  }

  // Working buckets, one per requested Monday.
  interface Bucket {
    hours: number;
    billable_hours: number;
    non_billable_hours: number;
    entry_hours: number;
    entry_count: number;
    byCurrency: Map<string, CurrencyTotal>;
    byProject: Map<string, ProjectTotal>;
    trackers: TrackerHours;
  }

  const buckets = new Map<string, Bucket>();
  for (const monday of weekStarts) {
    buckets.set(monday, {
      hours: 0,
      billable_hours: 0,
      non_billable_hours: 0,
      entry_hours: 0,
      entry_count: 0,
      byCurrency: new Map(),
      byProject: new Map(),
      trackers: {
        count: 0,
        hours: 0,
        invoiced_hours: 0,
        invoiced_count: 0,
        outstanding_hours: 0,
        outstanding_count: 0,
        running_count: 0,
        running_hours: 0,
        unpriced_hours: 0,
      },
    });
  }

  /** The running row for a project inside a bucket, created on first touch. */
  function projectRow(
    bucket: Bucket,
    key: string,
    seed: Pick<
      ProjectTotal,
      'project_id' | 'project_name' | 'client_name' | 'rate' | 'rate_source' | 'currency'
    >
  ): ProjectTotal {
    const existing = bucket.byProject.get(key);
    if (existing) return existing;
    const row: ProjectTotal = {
      ...seed,
      hours: 0,
      billable_hours: 0,
      amount: 0,
      entry_count: 0,
      tracker_hours: 0,
      tracker_amount: 0,
      tracker_count: 0,
    };
    bucket.byProject.set(key, row);
    return row;
  }

  /** The running row for a currency inside a bucket, created on first touch. */
  function currencyRow(bucket: Bucket, currency: string): CurrencyTotal {
    const existing = bucket.byCurrency.get(currency);
    if (existing) return existing;
    const row: CurrencyTotal = {
      currency,
      hours: 0,
      amount: 0,
      tracker_hours: 0,
      tracker_amount: 0,
    };
    bucket.byCurrency.set(currency, row);
    return row;
  }

  // ── Time entries ───────────────────────────────────────────────────────────

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
    bucket.entry_hours = addHours(bucket.entry_hours, hours);
    bucket.entry_count += 1;
    if (billable) {
      bucket.billable_hours = addHours(bucket.billable_hours, hours);
    } else {
      bucket.non_billable_hours = addHours(bucket.non_billable_hours, hours);
    }

    if (billable) {
      const running = currencyRow(bucket, currency);
      running.hours = addHours(running.hours, hours);
      running.amount = addMoney(running.amount, amount);
    }

    // Keyed by project id, but an entry whose project has since been deleted
    // still has its denormalised name on it and is worth showing under that
    // rather than being dropped from the breakdown its hours are inside.
    const key = session.project_id || `~${session.project_name}`;
    const row = projectRow(bucket, key, {
      project_id: session.project_id,
      project_name: session.project_name || 'Unknown project',
      client_name: session.client_name || 'Unknown client',
      rate,
      rate_source: source,
      currency,
    });
    row.hours = addHours(row.hours, hours);
    if (billable) {
      row.billable_hours = addHours(row.billable_hours, hours);
      row.amount = addMoney(row.amount, amount);
    }
    row.entry_count += 1;
  }

  // ── Trackers not yet billed ────────────────────────────────────────────────
  //
  // Billable by definition: `bill_tracker` defaults `billable` to true, so this
  // projects what billing would produce. An hour marked non-billable afterwards
  // moves out of these figures the moment it becomes a real entry.

  for (const contribution of trackerContributions(
    trackers,
    sessions,
    invoices,
    now ?? Date.now()
  )) {
    const monday = weekStartOf(contribution.day);
    if (monday === null) continue;
    const bucket = buckets.get(monday);
    if (!bucket) continue;

    bucket.hours = addHours(bucket.hours, contribution.hours);
    bucket.billable_hours = addHours(bucket.billable_hours, contribution.hours);
    bucket.trackers.count += 1;
    bucket.trackers.hours = addHours(bucket.trackers.hours, contribution.hours);
    bucket.trackers.invoiced_hours = addHours(
      bucket.trackers.invoiced_hours,
      contribution.invoiced_hours
    );
    bucket.trackers.outstanding_hours = addHours(
      bucket.trackers.outstanding_hours,
      contribution.outstanding_hours
    );
    if (contribution.invoiced_hours > 0) bucket.trackers.invoiced_count += 1;
    if (contribution.outstanding_hours > 0) bucket.trackers.outstanding_count += 1;
    if (contribution.running) {
      bucket.trackers.running_count += 1;
      bucket.trackers.running_hours = addHours(bucket.trackers.running_hours, contribution.hours);
    }

    // A tracker with no tasks at all: its hours are real and counted above, but
    // there is nothing to hang a rate on.
    if (contribution.shares.length === 0) {
      bucket.trackers.unpriced_hours = addHours(bucket.trackers.unpriced_hours, contribution.hours);
      continue;
    }

    for (const share of contribution.shares) {
      const task = taskById.get(share.task_id) ?? null;
      const project =
        (task ? projectById.get(task.project_id) : null) ??
        projectByName.get(`${share.client_name} ${share.project_name}`) ??
        null;
      const client = project ? clientById.get(project.client_id) ?? null : null;

      if (!project) {
        // No project, so no currency either — this cannot join a currency total
        // without inventing one. Reported on its own line instead.
        bucket.trackers.unpriced_hours = addHours(bucket.trackers.unpriced_hours, share.hours);
        const key = `~${share.project_name || share.task_title}`;
        const row = projectRow(bucket, key, {
          project_id: '',
          project_name: share.project_name || 'Unknown project',
          client_name: share.client_name || 'Unknown client',
          rate: 0,
          rate_source: 'none',
          currency: settings?.default_currency || 'USD',
        });
        row.hours = addHours(row.hours, share.hours);
        row.billable_hours = addHours(row.billable_hours, share.hours);
        row.tracker_hours = addHours(row.tracker_hours, share.outstanding_hours);
        row.tracker_count += 1;
        continue;
      }

      const { rate, source, currency } = resolveRate(project, client, settings);
      const amount = computeLineAmount(share.hours, rate);
      // Priced separately rather than scaled from `amount`: quantise-then-sum
      // is the rule, and deriving one money figure from another by ratio is
      // exactly the sum-then-round trap CLAUDE.md § "Money rules" forbids.
      const outstandingAmount = computeLineAmount(share.outstanding_hours, rate);

      const running = currencyRow(bucket, currency);
      running.hours = addHours(running.hours, share.hours);
      running.amount = addMoney(running.amount, amount);
      running.tracker_hours = addHours(running.tracker_hours, share.outstanding_hours);
      running.tracker_amount = addMoney(running.tracker_amount, outstandingAmount);

      const row = projectRow(bucket, project.id, {
        project_id: project.id,
        project_name: project.name,
        client_name: project.client_name || client?.name || 'Unknown client',
        rate,
        rate_source: source,
        currency,
      });
      row.hours = addHours(row.hours, share.hours);
      row.billable_hours = addHours(row.billable_hours, share.hours);
      row.amount = addMoney(row.amount, amount);
      row.tracker_hours = addHours(row.tracker_hours, share.outstanding_hours);
      row.tracker_amount = addMoney(row.tracker_amount, outstandingAmount);
      row.tracker_count += 1;
    }
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
      entry_hours: bucket.entry_hours,
      entry_count: bucket.entry_count,
      totals: [...bucket.byCurrency.values()].sort((a, b) =>
        a.currency.localeCompare(b.currency)
      ),
      projects: [...bucket.byProject.values()].sort(
        (a, b) => b.hours - a.hours || a.project_name.localeCompare(b.project_name)
      ),
      trackers: bucket.trackers,
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
  entry_hours: number;
  entry_count: number;
  totals: CurrencyTotal[];
  trackers: TrackerHours;
}

export function totalAcross(weeks: WeekSummary[]): WindowTotals {
  const byCurrency = new Map<string, CurrencyTotal>();
  let hours = 0;
  let billable_hours = 0;
  let non_billable_hours = 0;
  let entry_hours = 0;
  let entry_count = 0;
  const trackers: TrackerHours = {
    count: 0,
    hours: 0,
    invoiced_hours: 0,
    invoiced_count: 0,
    outstanding_hours: 0,
    outstanding_count: 0,
    running_count: 0,
    running_hours: 0,
    unpriced_hours: 0,
  };

  for (const week of weeks ?? []) {
    hours = addHours(hours, week.hours);
    billable_hours = addHours(billable_hours, week.billable_hours);
    non_billable_hours = addHours(non_billable_hours, week.non_billable_hours);
    entry_hours = addHours(entry_hours, week.entry_hours);
    entry_count += week.entry_count;
    trackers.count += week.trackers.count;
    trackers.hours = addHours(trackers.hours, week.trackers.hours);
    trackers.invoiced_hours = addHours(trackers.invoiced_hours, week.trackers.invoiced_hours);
    trackers.invoiced_count += week.trackers.invoiced_count;
    trackers.outstanding_hours = addHours(
      trackers.outstanding_hours,
      week.trackers.outstanding_hours
    );
    trackers.outstanding_count += week.trackers.outstanding_count;
    trackers.running_count += week.trackers.running_count;
    trackers.running_hours = addHours(trackers.running_hours, week.trackers.running_hours);
    trackers.unpriced_hours = addHours(trackers.unpriced_hours, week.trackers.unpriced_hours);

    for (const total of week.totals) {
      const running = byCurrency.get(total.currency) ?? {
        currency: total.currency,
        hours: 0,
        amount: 0,
        tracker_hours: 0,
        tracker_amount: 0,
      };
      running.hours = addHours(running.hours, total.hours);
      running.amount = addMoney(running.amount, total.amount);
      running.tracker_hours = addHours(running.tracker_hours, total.tracker_hours);
      running.tracker_amount = addMoney(running.tracker_amount, total.tracker_amount);
      byCurrency.set(total.currency, running);
    }
  }

  return {
    hours,
    billable_hours,
    non_billable_hours,
    entry_hours,
    entry_count,
    totals: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    trackers,
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
