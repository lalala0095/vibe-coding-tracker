// How many hours went in each week, and what they are worth.
//
// Read-only, top to bottom. Every figure rendered here arrives already computed
// and quantised by `lib/weeklySummary.ts`; this file does no arithmetic of its
// own, on purpose. Money math lives in one place (`lib/money.ts`, the twin of
// `back/services/invoice_service.py`) and a second implementation inside a
// component is exactly how the two drift apart — CLAUDE.md §"Money rules".
//
// Three things on this pane look like decoration and are not. A future reader
// tidying up will reach for all three first, so each is spelled out where it is
// rendered as well as here:
//
//   1. Currencies are listed, never added. Each client carries its own
//      `currency` and this system holds no exchange rate anywhere, so "total
//      earned" across a USD client and a PHP client is not a number that
//      exists. `totals` is a list for that reason, and rendering it as a list
//      is the whole point — see the "Currencies do not add up" note in the lib
//      header, and `PaymentsPanel`'s received_totals, which makes the same call.
//
//   2. The unbilled-tracker note is the most important thing on a card. Every
//      figure here comes from time entries, because a tracker has no project
//      and therefore no rate to price it with. A tracker you stopped but never
//      billed contributes nothing — so without this note the week silently
//      reads low, and reads low in precisely the situation you opened this pane
//      to look at.
//
//   3. The estimate disclaimer is not boilerplate. These figures are
//      `hours × rate` and nothing else, while a real invoice can carry a
//      per-line rate override, a discount and tax. The two are *allowed* to
//      disagree, and saying so once here is cheaper than explaining a mismatch
//      later.
//
// Naming: the `sessions` collection is called "Time Entries" in the UI. The
// word "Sessions" belongs to the `goals` collection (AI prompt/output records)
// and must never appear on this pane — CLAUDE.md §Traps.

import { useMemo, useState, type ReactNode } from 'react';
import {
  RATE_SOURCE_LABEL,
  averageWeeklyHours,
  totalAcross,
  type ProjectTotal,
  type WeekSummary,
} from '../lib/weeklySummary';
import { formatHours, formatMoney } from '../lib/money';

const WEEK_COUNTS = [4, 12, 26] as const;

// ── Small pieces ──────────────────────────────────────────────────────────────

/**
 * Amber is "worth knowing, not an error". Nothing on this pane is broken when a
 * note appears: an unbilled tracker is a normal state of the world, and a zero
 * rate is usually deliberate. Same tone as `PaymentsPanel`'s warnings, kept
 * local so this pane does not import a component named for payments.
 */
function AmberNote({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
      <svg className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <div className="text-xs leading-relaxed min-w-0">
        <p className="font-medium text-amber-300">{title}</p>
        {children && <p className="mt-0.5 text-amber-300/70">{children}</p>}
      </div>
    </div>
  );
}

/** A labelled figure in the totals strip. */
function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className="text-lg font-semibold text-slate-100 tabular-nums mt-0.5">{value}</p>
      {hint && <p className="text-xs text-slate-600 mt-0.5">{hint}</p>}
    </div>
  );
}

/**
 * What a project's rate means, in words.
 *
 * `null` and `0` are different answers and the whole Clients & Projects screen
 * is built around not conflating them (`mobile/src/screens/clients/rates.ts`:
 * "null is not 0"). By the time a rate reaches here the chain has already been
 * resolved, so the surviving distinction is between a deliberate zero — some
 * level of the chain says "bill nothing" — and `rate_source === 'none'`, where
 * no level had a rate at all and the invoice settings may simply not have
 * loaded. The first is a decision; the second is a gap. They cost very
 * different amounts of money to ignore.
 */
function zeroRateNote(row: ProjectTotal): string | null {
  if (row.rate !== 0) return null;
  if (row.rate_source === 'none') {
    return 'No rate set — nothing was found on the project, the client or the invoice settings, so these hours price at nothing rather than bill at nothing.';
  }
  return `Zero is a real rate — ${RATE_SOURCE_LABEL[row.rate_source].toLowerCase()} bills nothing for this project.`;
}

// ── Week card ─────────────────────────────────────────────────────────────────

function WeekCard({
  week, open, onToggle,
}: {
  week: WeekSummary;
  open: boolean;
  onToggle: () => void;
}) {
  // `weekHeading` returns the date range itself for any week older than last
  // week, so for most cards the heading already IS the range and repeating it
  // underneath would print the same string twice.
  const showRange = week.heading !== week.range;
  const hasProjects = week.projects.length > 0;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3.5 flex flex-col gap-3">
      {/* ── Heading + headline hours ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-100">{week.heading}</h3>
          {showRange && <p className="text-xs text-slate-500 mt-0.5">{week.range}</p>}
        </div>
        <div className="text-right shrink-0">
          <p className={`text-xl font-semibold tabular-nums ${
            week.hours === 0 ? 'text-slate-600' : 'text-slate-100'
          }`}>
            {formatHours(week.hours)}
          </p>
          {week.entry_count > 0 && (
            <p className="text-xs text-slate-500 mt-0.5">
              {week.entry_count} time {week.entry_count === 1 ? 'entry' : 'entries'}
            </p>
          )}
        </div>
      </div>

      {/* ── Billable / non-billable ──
          Non-billable hours are real hours that convert to no money. They are
          inside the headline figure and outside every money figure, so the two
          only reconcile if the split is stated. Dropping this line makes the
          money look wrong for a week that was simply not chargeable. */}
      {week.non_billable_hours > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
          <span className="text-slate-400">
            Billable{' '}
            <span className="text-slate-200 tabular-nums">{formatHours(week.billable_hours)}</span>
          </span>
          <span className="text-slate-400">
            Non-billable{' '}
            <span className="text-slate-300 tabular-nums">{formatHours(week.non_billable_hours)}</span>
          </span>
          <span className="text-slate-600">— tracked, but billed to nobody.</span>
        </div>
      )}

      {/* ── Money, one line per currency ──
          Never a single blended figure: there is no exchange rate in this
          system, so two currencies in a week have two answers and no third one. */}
      {week.totals.length > 0 ? (
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {week.totals.map((total) => (
            <div key={total.currency} className="flex items-baseline gap-2">
              <span className="text-base font-medium text-slate-100 tabular-nums">
                {formatMoney(total.amount, total.currency)}
              </span>
              <span className="text-xs text-slate-500">
                {total.currency} · {formatHours(total.hours)}
              </span>
            </div>
          ))}
        </div>
      ) : week.hours > 0 ? (
        <p className="text-xs text-slate-500">
          Nothing billable — every time entry this week is marked non-billable.
        </p>
      ) : null}

      {/* ── Unbilled trackers ──
          The one note that changes what the numbers above MEAN. These hours are
          absent from every figure on this card, so the card reads low until
          they are billed. Written as an explanation and a next step, not as an
          error: not billing a tracker yet is normal. */}
      {week.unbilled.count > 0 && (
        <AmberNote
          title={
            week.unbilled.count === 1
              ? '1 tracker stopped this week was never billed into time entries.'
              : `${week.unbilled.count} trackers stopped this week were never billed into time entries.`
          }
        >
          Roughly {formatHours(week.unbilled.hours)} of elapsed tracker time is missing from
          every figure on this card, so the week reads low. Bill the tracker from the Trackers
          tab and its hours appear here.
        </AmberNote>
      )}

      {/* ── Per-project breakdown ── */}
      {hasProjects && (
        <div className="border-t border-slate-800 pt-2.5">
          <button
            onClick={onToggle}
            className="flex items-center gap-1.5 text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors"
          >
            <svg
              className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
            {week.projects.length} {week.projects.length === 1 ? 'project' : 'projects'}
          </button>

          {open && (
            <div className="mt-2.5 flex flex-col gap-2">
              {week.projects.map((row) => {
                const note = zeroRateNote(row);
                return (
                  <div
                    key={row.project_id || row.project_name}
                    className="flex flex-col gap-1 rounded-lg bg-slate-950/60 border border-slate-800/60 px-3 py-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-slate-100 truncate">{row.project_name}</p>
                        <p className="text-xs text-slate-500 truncate">{row.client_name}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm text-slate-200 tabular-nums">{formatHours(row.hours)}</p>
                        <p className="text-xs text-slate-400 tabular-nums">
                          {formatMoney(row.amount, row.currency)}
                        </p>
                      </div>
                    </div>

                    {/* The rate AND where it came from. A bare figure cannot
                        answer "why is this total what it is", which is the next
                        question a surprising number gets asked. */}
                    <p className="text-xs text-slate-500 tabular-nums">
                      {formatMoney(row.rate, row.currency)}/hr
                      <span className="text-slate-600"> · {RATE_SOURCE_LABEL[row.rate_source]}</span>
                    </p>

                    {/* Hours that were logged but not billable do not reach the
                        amount, so the row only adds up when the gap is named. */}
                    {row.billable_hours !== row.hours && (
                      <p className="text-xs text-slate-600">
                        {formatHours(row.billable_hours)} of this is billable.
                      </p>
                    )}

                    {note && <p className="text-xs text-amber-300/80">{note}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Pane ──────────────────────────────────────────────────────────────────────

export interface WeeklySummaryPaneProps {
  /** Newest week first. Weeks with no hours are present and must still render. */
  weeks: WeekSummary[];
  /** How many weeks are being shown — 4, 12 or 26. */
  weekCount: number;
  onChangeWeekCount: (count: number) => void;
  loading: boolean;
  /** '' when there is nothing wrong. */
  error: string;
  onRetry: () => void;
}

export default function WeeklySummaryPane({
  weeks, weekCount, onChangeWeekCount, loading, error, onRetry,
}: WeeklySummaryPaneProps) {
  // Which weeks have their project breakdown open. Held as an override map
  // rather than a set of open keys so the default — newest week expanded — can
  // still apply to weeks that arrive after the first render, which is every
  // week, since the first render is the loading one.
  const [openWeeks, setOpenWeeks] = useState<Record<string, boolean>>({});

  const totals = useMemo(() => totalAcross(weeks), [weeks]);
  const average = useMemo(() => averageWeeklyHours(weeks), [weeks]);

  // "Nothing here" covers both no weeks at all and a window of quiet weeks. The
  // weeks themselves are still real and still listed below by `summariseWeeks`;
  // this only decides whether to explain the emptiness first.
  //
  // Keyed on `entry_count`, not on `hours === 0`: those two come apart when every
  // entry in the window rounds to 0.00 h, and saying "no time entries fall in the
  // last N weeks" over a window that has some would be a plain falsehood. The two
  // cases get different copy below.
  const nothingTracked = weeks.length === 0 || totals.entry_count === 0;
  const trackedButUnmeasured = !nothingTracked && totals.hours === 0;

  const toggleWeek = (key: string, fallback: boolean) => {
    setOpenWeeks((prev) => ({ ...prev, [key]: !(prev[key] ?? fallback) }));
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* ── Header ──
          Sticky rather than a fixed sibling so the range selector stays reachable
          however far down the list you are. Solid background: the cards scroll
          underneath it. */}
      <div className="sticky top-0 z-10 shrink-0 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm font-semibold text-white">Weekly summary</span>
        <div className="flex gap-1">
          {WEEK_COUNTS.map((count) => (
            <button
              key={count}
              onClick={() => onChangeWeekCount(count)}
              className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                weekCount === count
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {count} weeks
            </button>
          ))}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : error ? (
          <div className="p-6 flex flex-col items-start gap-3">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={onRetry}
              className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-4">
            {/* ── Totals for the whole window ──
                Suppressed when there is nothing to total. A strip of 0.00 h
                figures with an estimate disclaimer under them reads like a
                broken load rather than an empty diary, and the card below says
                the same thing in words that help. */}
            {!nothingTracked && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3.5 flex flex-col gap-3">
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Figure label="Total hours" value={formatHours(totals.hours)} />
                <Figure
                  label="Average week"
                  value={formatHours(average)}
                  hint="Across weeks with hours in them."
                />
                {/* One figure per currency, side by side and never added. There
                    is no exchange rate anywhere in this app, so a combined
                    number would be invented rather than computed. */}
                {totals.totals.map((total) => (
                  <Figure
                    key={total.currency}
                    label={total.currency}
                    value={formatMoney(total.amount, total.currency)}
                    hint={formatHours(total.hours)}
                  />
                ))}
              </div>

              {totals.totals.length > 1 && (
                <p className="text-xs text-slate-600">
                  Shown one currency at a time. There is no exchange rate here, so these are
                  never added into a single total.
                </p>
              )}

              {totals.non_billable_hours > 0 && (
                <p className="text-xs text-slate-500">
                  <span className="tabular-nums text-slate-300">
                    {formatHours(totals.non_billable_hours)}
                  </span>{' '}
                  of the total is non-billable and earns nothing.
                </p>
              )}

              {/* Said once, quietly, next to the figures it qualifies. */}
              <p className="text-xs text-slate-600">
                Estimate — hours × rate only. An invoice can also carry a per-line rate
                override, a discount and tax, so its total may differ.
              </p>
            </div>
            )}

            {/* Entries exist, but every one of them rounds to 0.00 h. Distinct from
                "nothing tracked": the entries are real and the hours on them are
                editable, so this points at the entry rather than at the tracker. */}
            {trackedButUnmeasured && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-4">
                <p className="text-sm text-slate-300">
                  {totals.entry_count} time {totals.entry_count === 1 ? 'entry' : 'entries'} in
                  the last {weekCount} weeks, and none of them carries any measurable time.
                </p>
                <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                  Hours round to two decimal places, so anything under about half a minute
                  reads as 0.00 h. Set the hours on the entry directly from the Time Entries
                  page.
                </p>
              </div>
            )}

            {/* ── Nothing tracked ── */}
            {nothingTracked && (
              <div className="flex flex-col gap-3">
                <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-4">
                  <p className="text-sm text-slate-300">
                    No time entries fall in the last {weekCount} weeks.
                  </p>
                  <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                    Hours only reach this pane once a tracker has been billed into time
                    entries — a tracker on its own is a grouping and carries no rate to price
                    it with. Bill one from the Trackers tab and its hours appear in the week
                    it started.
                  </p>
                </div>

                {/* The likeliest reason the window is empty, so it belongs here
                    and not only on the individual cards below. */}
                {totals.unbilled.count > 0 && (
                  <AmberNote
                    title={
                      totals.unbilled.count === 1
                        ? '1 stopped tracker in this window was never billed into time entries.'
                        : `${totals.unbilled.count} stopped trackers in this window were never billed into time entries.`
                    }
                  >
                    That is roughly {formatHours(totals.unbilled.hours)} of elapsed tracker
                    time not counted anywhere on this pane.
                  </AmberNote>
                )}
              </div>
            )}

            {/* ── One card per week, newest first ──
                A quiet week among busy ones is a real answer and is kept — hiding
                it would make the stretch look denser than it was. A window where
                EVERY week is quiet is a different thing: twelve identical empty
                cards say nothing the message above has not already said better,
                so the list is dropped entirely in that case. */}
            {!nothingTracked && weeks.map((week, index) => (
              <WeekCard
                key={week.key}
                week={week}
                open={openWeeks[week.key] ?? index === 0}
                onToggle={() => toggleWeek(week.key, index === 0)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
