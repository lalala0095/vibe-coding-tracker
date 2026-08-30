// How many hours went in each week, and what they are worth — the phone's copy
// of `front/src/components/WeeklySummaryPane.tsx`.
//
// A port of the layout only. Every figure rendered here arrives already
// computed and quantised by `@/lib/weeklySummary`, which is itself a verbatim
// copy of the web's; this file does no arithmetic of its own, on purpose. Money
// math lives in one place (`@/lib/money`, the twin of
// `back/services/invoice_service.py`) and a second implementation inside a
// component is exactly how the phone and the web start quoting different money
// for the same week — CLAUDE.md § "Money rules".
//
// ── This view does not scroll ────────────────────────────────────────────────
//
// `@/components/Screen` owns the scroll body and pull-to-refresh, and a
// `ScrollView` nested inside another one breaks both: the inner list eats the
// pull gesture and the outer one can no longer measure its content. So there is
// no `ScrollView`, no `FlatList` and no `overflow` here, and nothing claims a
// height: the root is a plain `View` that is exactly as tall as its children,
// and the screen above it does the scrolling.
//
// The `flex-1`s below are all `min-w-0 flex-1` on a child of a `flex-row` — the
// truncation idiom `TrackerRow` and `TotalsCard` use, growing along the
// horizontal axis only. None of them is on the root or on a column.
//
// ── Three things here look like decoration and are not ───────────────────────
//
//   1. Currencies are listed, never added. Each client carries its own
//      `currency` and this system holds no exchange rate anywhere, so "total
//      earned" across a USD client and a PHP client is not a number that
//      exists. `totals` is a list for that reason, and rendering it as a list
//      is the whole point — see the "Currencies do not add up" note in the lib
//      header, and `screens/invoices/payments/PaymentsPanel`'s received_totals,
//      which makes the same call.
//
//   2. The provenance split is the most important thing on a card. Hours here
//      come from two places: time entries, which are billed and invoiceable,
//      and trackers that have not been billed yet, which `@/lib/weeklySummary`
//      now prices by hopping `TrackerTaskRef.task_id` → `Task.project_id` — the
//      same hop `bill_tracker` makes. Tracker time is therefore INSIDE every
//      figure on a card, not missing from it, and the card no longer reads low
//      for someone who bills at month end. But it is a projection of a bill
//      that has not been raised, so wherever a figure is mixed the card says
//      how much of it came from a tracker (`entry_hours` vs `trackers.hours`,
//      `tracker_amount` on a currency, a chip on a project row). Nothing extra
//      renders when the tracker part is zero: a fully-billed week must look
//      exactly as clean as it always did. Running trackers and hours that
//      reached no project (`unpriced_hours` — in the total, in no money figure)
//      are called out for the same reason.
//
//   3. The estimate disclaimer is not boilerplate. These figures are
//      `hours × rate` and nothing else, while a real invoice can carry a
//      per-line rate override, a discount and tax. The two are *allowed* to
//      disagree, and saying so once here is cheaper than explaining a mismatch
//      later.
//
// Naming: the `sessions` collection is called "Time Entries" in the UI. The
// word "Sessions" belongs to the `goals` collection (AI prompt/output records)
// and must never appear on this view — CLAUDE.md § Traps.

import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Card, Chip, EmptyState, ErrorNote, LoadingBlock } from '@/components';
import { formatHours, formatMoney } from '@/lib/money';
import {
  RATE_SOURCE_LABEL,
  averageWeeklyHours,
  totalAcross,
  type ProjectTotal,
  type TrackerHours,
  type WeekSummary,
} from '@/lib/weeklySummary';

const WEEK_COUNTS = [4, 12, 26] as const;

// ── Small pieces ──────────────────────────────────────────────────────────────

/**
 * Amber is "worth knowing, not an error". Nothing here is broken when a note
 * appears: an unbilled tracker is a normal state of the world, and a zero rate
 * is usually deliberate.
 *
 * Kept local, exactly as the web pane keeps its own, so this view does not
 * import a component named for payments — `screens/invoices/payments/
 * PaymentWarning.tsx` is the same shape and the same amber, and promoting it
 * into `src/components/` is the fix. That is not this file's to make.
 */
function AmberNote({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View className="flex-row items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
      {/* No icon library in this app — glyphs are text characters, the same
          call `TrackerRow` makes for its disclosure arrow. */}
      <Text className="text-xs text-amber-400">⚠</Text>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-xs font-medium leading-relaxed text-amber-300">{title}</Text>
        {children ? (
          <Text className="text-xs leading-relaxed text-amber-300/70">{children}</Text>
        ) : null}
      </View>
    </View>
  );
}

/** A labelled figure in the totals strip. */
function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View className="min-w-0">
      <Text className="text-[11px] uppercase tracking-wider text-slate-500">{label}</Text>
      <Text className="mt-0.5 text-lg font-semibold tabular-nums text-slate-100">{value}</Text>
      {hint ? <Text className="mt-0.5 text-xs text-slate-600">{hint}</Text> : null}
    </View>
  );
}

/**
 * What a project's rate means, in words.
 *
 * `null` and `0` are different answers and the whole Clients & Projects screen
 * is built around not conflating them (`src/screens/clients/rates.ts`: "null is
 * not 0"). By the time a rate reaches here the chain has already been resolved,
 * so the surviving distinction is between a deliberate zero — some level of the
 * chain says "bill nothing" — and `rate_source === 'none'`, where no level had
 * a rate at all and the invoice settings may simply not have loaded. The first
 * is a decision; the second is a gap. They cost very different amounts of money
 * to ignore.
 */
function zeroRateNote(row: ProjectTotal): string | null {
  if (row.rate !== 0) return null;
  if (row.rate_source === 'none') {
    return 'No rate set — nothing was found on the project, the client or the invoice settings, so these hours price at nothing rather than bill at nothing.';
  }
  return `Zero is a real rate — ${RATE_SOURCE_LABEL[row.rate_source].toLowerCase()} bills nothing for this project.`;
}

/**
 * What the tracker share of a figure has to say, in order of what it changes.
 *
 * Every line here qualifies hours that are already counted above it: the
 * projection, the timer that is still running, and the part nothing could price.
 * One helper rather than two copies because the week card and the window totals
 * must not drift into describing the same arithmetic differently.
 *
 * Nothing is clamped or hidden, including a timer left running overnight —
 * CLAUDE.md § "no locking". Every figure below arrives pre-quantised from
 * `@/lib/weeklySummary`; this only chooses words.
 */
function trackerNoteLines(trackers: TrackerHours): string[] {
  // `outstanding_hours`, never `hours`. Tracker time already billed straight
  // onto an invoice line is inside `hours`, and calling that "not billed yet"
  // was the defect this helper is named for.
  const lines = [
    `${formatHours(trackers.outstanding_hours)} of that is tracker time not billed or invoiced yet — included above as a projection. Bill it from the Trackers tab to make it invoiceable.`,
  ];

  if (trackers.running_count > 0) {
    lines.push(
      trackers.running_count === 1
        ? `1 tracker is still running: ${formatHours(trackers.running_hours)} of it is measured to right now and still growing.`
        : `${trackers.running_count} trackers are still running: ${formatHours(trackers.running_hours)} of that is measured to right now and still growing.`
    );
  }

  // In the hours, in no money figure — the one line here that says a figure is
  // genuinely incomplete rather than merely provisional.
  if (trackers.unpriced_hours > 0) {
    lines.push(
      `${formatHours(trackers.unpriced_hours)} reached no project, so it counts in the hours but in no money figure. Attach a task to that tracker to price it.`
    );
  }

  return lines;
}

// ── Week card ─────────────────────────────────────────────────────────────────

function WeekCard({
  week,
  open,
  onToggle,
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
    <Card padded={false}>
      <View className="gap-3 px-4 py-3.5">
        {/* ── Heading + headline hours ── */}
        <View className="flex-row items-start justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-base font-semibold text-slate-100" numberOfLines={1}>
              {week.heading}
            </Text>
            {showRange ? (
              <Text className="mt-0.5 text-xs text-slate-500" numberOfLines={1}>
                {week.range}
              </Text>
            ) : null}
          </View>
          {/* `shrink-0`: at 375px a long heading must truncate rather than push
              the hours figure off the right edge. */}
          <View className="shrink-0 items-end">
            <Text
              className={`text-xl font-semibold tabular-nums ${
                week.hours === 0 ? 'text-slate-600' : 'text-slate-100'
              }`}
            >
              {formatHours(week.hours)}
            </Text>
            {week.entry_count > 0 ? (
              <Text className="mt-0.5 text-xs text-slate-500">
                {week.entry_count} time {week.entry_count === 1 ? 'entry' : 'entries'}
              </Text>
            ) : null}
          </View>
        </View>

        {/* ── Where the headline hours came from ──
            Only when the two sources are actually mixed. The figure above is
            time entries plus unbilled tracker time, and those two are worth
            very different amounts today: one is invoiceable, the other is a
            projection. A fully-billed week renders none of this. */}
        {week.trackers.hours > 0 ? (
          <View className="flex-row flex-wrap items-baseline gap-x-4 gap-y-1">
            <Text className="text-xs text-slate-400">
              Time entries{' '}
              <Text className="tabular-nums text-slate-200">{formatHours(week.entry_hours)}</Text>
            </Text>
            {week.trackers.invoiced_hours > 0 ? (
              <Text className="text-xs text-slate-400">
                Invoiced{' '}
                <Text className="tabular-nums text-slate-200">
                  {formatHours(week.trackers.invoiced_hours)}
                </Text>
              </Text>
            ) : null}
            {week.trackers.outstanding_hours > 0 ? (
              <Text className="text-xs text-slate-400">
                Not billed yet{' '}
                <Text className="tabular-nums text-amber-300">
                  {formatHours(week.trackers.outstanding_hours)}
                </Text>
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* ── Billable / non-billable ──
            Non-billable hours are real hours that convert to no money. They are
            inside the headline figure and outside every money figure, so the
            two only reconcile if the split is stated. Dropping this line makes
            the money look wrong for a week that was simply not chargeable. */}
        {week.non_billable_hours > 0 ? (
          <View className="flex-row flex-wrap items-baseline gap-x-4 gap-y-1">
            <Text className="text-xs text-slate-400">
              Billable <Text className="tabular-nums text-slate-200">{formatHours(week.billable_hours)}</Text>
            </Text>
            <Text className="text-xs text-slate-400">
              Non-billable{' '}
              <Text className="tabular-nums text-slate-300">{formatHours(week.non_billable_hours)}</Text>
            </Text>
            <Text className="text-xs text-slate-600">— tracked, but billed to nobody.</Text>
          </View>
        ) : null}

        {/* ── Money, one line per currency ──
            Never a single blended figure: there is no exchange rate in this
            system, so two currencies in a week have two answers and no third
            one. Stacked rather than wrapped side by side — at 375px two money
            figures on one line truncate each other. */}
        {week.totals.length > 0 ? (
          <View className="gap-1">
            {week.totals.map((total) => (
              <View key={total.currency}>
                <View className="flex-row items-baseline gap-2">
                  <Text className="text-base font-medium tabular-nums text-slate-100">
                    {formatMoney(total.amount, total.currency)}
                  </Text>
                  <Text className="min-w-0 flex-1 text-xs text-slate-500" numberOfLines={1}>
                    {total.currency} · {formatHours(total.hours)}
                  </Text>
                </View>
                {/* Part of the amount above, never an addend — the money a
                    tracker would raise if it were billed. No `numberOfLines`:
                    the line may wrap, but truncating a money figure at 375px is
                    not an option. */}
                {total.tracker_hours > 0 ? (
                  <Text className="text-xs tabular-nums text-amber-300/70">
                    of which {formatMoney(total.tracker_amount, total.currency)} ·{' '}
                    {formatHours(total.tracker_hours)} not billed yet
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : week.hours > 0 ? (
          <Text className="text-xs leading-relaxed text-slate-500">
            {week.entry_hours === 0 && week.trackers.unpriced_hours > 0
              ? 'No money figure — the tracker time this week reached no project, so nothing prices it.'
              : 'Nothing billable — every time entry this week is marked non-billable.'}
          </Text>
        ) : null}

        {/* ── Tracker time inside the figures above ──
            Not a warning that something is missing: these hours ARE counted in
            every figure on this card. What they are not is billed, and until
            they are they cannot go on an invoice. Written as provenance and a
            next step — billing at month end is the normal way to work here. */}
        {week.trackers.outstanding_count > 0 ? (
          <AmberNote
            title={
              week.trackers.outstanding_count === 1
                ? '1 tracker this week is counted here but not billed yet.'
                : `${week.trackers.outstanding_count} trackers this week are counted here but not billed yet.`
            }
          >
            {trackerNoteLines(week.trackers).join('\n')}
          </AmberNote>
        ) : null}
      </View>

      {/* ── Per-project breakdown ── */}
      {hasProjects ? (
        <View className="border-t border-slate-800">
          {/* The whole row is the target, not the glyph — `TrackerRow` makes the
              same call. `hitSlop` on top of the padding so the tap area clears
              a fingertip either way. */}
          <Pressable
            onPress={onToggle}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            className="flex-row items-center justify-between gap-3 px-4 py-3 active:bg-slate-800"
          >
            <Text className="text-xs font-medium text-violet-400">
              {week.projects.length} {week.projects.length === 1 ? 'project' : 'projects'}
            </Text>
            <Text className="text-lg leading-none text-slate-500">{open ? '⌄' : '›'}</Text>
          </Pressable>

          {open ? (
            <View className="gap-2 px-4 pb-3">
              {week.projects.map((row) => {
                const note = zeroRateNote(row);
                return (
                  <View
                    key={row.project_id || row.project_name}
                    className="gap-1 rounded-lg border border-slate-800/60 bg-slate-950/60 px-3 py-2"
                  >
                    <View className="flex-row items-start justify-between gap-3">
                      <View className="min-w-0 flex-1">
                        {/* Long project and client names truncate; the money on
                            the right must never be the thing pushed off. */}
                        <Text className="text-sm text-slate-100" numberOfLines={1}>
                          {row.project_name}
                        </Text>
                        <Text className="text-xs text-slate-500" numberOfLines={1}>
                          {row.client_name}
                        </Text>
                      </View>
                      <View className="shrink-0 items-end">
                        <Text className="text-sm tabular-nums text-slate-200">
                          {formatHours(row.hours)}
                        </Text>
                        <Text className="text-xs tabular-nums text-slate-400">
                          {formatMoney(row.amount, row.currency)}
                        </Text>
                      </View>
                    </View>

                    {/* The rate AND where it came from. A bare figure cannot
                        answer "why is this total what it is", which is the next
                        question a surprising number gets asked. */}
                    <Text className="text-xs tabular-nums text-slate-500">
                      {formatMoney(row.rate, row.currency)}/hr
                      <Text className="text-slate-600"> · {RATE_SOURCE_LABEL[row.rate_source]}</Text>
                    </Text>

                    {/* Part of the hours and amount on this row, not extra. The
                        row's `entry_count` can legitimately be 0 while the row
                        carries real hours — a project reached only through a
                        tracker — so the chip is what explains the row at all. */}
                    {row.tracker_hours > 0 ? (
                      <Chip label={`${formatHours(row.tracker_hours)} not billed`} tone="amber" />
                    ) : null}

                    {/* Hours that were logged but not billable do not reach the
                        amount, so the row only adds up when the gap is named. */}
                    {row.billable_hours !== row.hours ? (
                      <Text className="text-xs text-slate-600">
                        {formatHours(row.billable_hours)} of this is billable.
                      </Text>
                    ) : null}

                    {note ? (
                      <Text className="text-xs leading-relaxed text-amber-300/80">{note}</Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

// ── View ──────────────────────────────────────────────────────────────────────

export interface WeeklySummaryViewProps {
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

export default function WeeklySummaryView({
  weeks,
  weekCount,
  onChangeWeekCount,
  loading,
  error,
  onRetry,
}: WeeklySummaryViewProps) {
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
  // `hours` first, because hours now arrive from time entries AND from trackers
  // not yet billed: a month of daily trackers and no billing run has
  // `entry_count === 0` and is emphatically not empty, and keying on the count
  // alone would hide the whole window behind an empty state.
  //
  // `entry_count` still has one job — the window where entries exist but every
  // one of them rounds to 0.00 h. That is not "nothing tracked" and gets its
  // own copy below, so the two conditions stay separate rather than collapsing
  // into `hours === 0`.
  const nothingTracked = weeks.length === 0 || (totals.hours === 0 && totals.entry_count === 0);
  const trackedButUnmeasured = !nothingTracked && totals.hours === 0;

  const toggleWeek = (key: string, fallback: boolean) => {
    setOpenWeeks((prev) => ({ ...prev, [key]: !(prev[key] ?? fallback) }));
  };

  // The range selector. The web keeps it in a sticky header; there is no header
  // to be sticky in here — `Screen` owns the chrome — so it sits at the top of
  // the content, and it stays rendered through the loading and error states so
  // the window can be changed without a working fetch. Same pills as the
  // Trackers filter row, so the two rows on this screen are one gesture.
  const rangePills = (
    <View className="flex-row flex-wrap gap-2">
      {WEEK_COUNTS.map((count) => {
        const active = weekCount === count;
        return (
          <Chip
            key={count}
            label={`${count} weeks`}
            size="md"
            tone={active ? 'violet' : 'slate'}
            className={active ? '' : 'opacity-60'}
            onPress={() => onChangeWeekCount(count)}
            testID={`weekly-range-${count}`}
          />
        );
      })}
    </View>
  );

  // No `flex-1`, no scroll container: the parent `Screen` scrolls this.
  return (
    <View className="gap-4">
      {rangePills}

      {loading ? (
        <LoadingBlock label="Loading weekly summary…" />
      ) : error ? (
        <ErrorNote message={error} onRetry={onRetry} retryLabel="Retry" />
      ) : (
        <>
          {/* ── Totals for the whole window ──
              Suppressed when there is nothing to total. A strip of 0.00 h
              figures with an estimate disclaimer under them reads like a broken
              load rather than an empty diary, and the message below says the
              same thing in words that help. */}
          {!nothingTracked ? (
            <Card>
              <View className="gap-3">
                <View className="flex-row flex-wrap gap-x-6 gap-y-3">
                  <Figure
                    label="Total hours"
                    value={formatHours(totals.hours)}
                    // Only when the two sources are mixed — an all-billed
                    // window keeps the bare figure it has always had.
                    hint={
                      totals.trackers.hours > 0
                        ? [
                            `${formatHours(totals.entry_hours)} time entries`,
                            totals.trackers.invoiced_hours > 0
                              ? `${formatHours(totals.trackers.invoiced_hours)} invoiced`
                              : null,
                            totals.trackers.outstanding_hours > 0
                              ? `${formatHours(totals.trackers.outstanding_hours)} not billed yet`
                              : null,
                          ]
                            .filter(Boolean)
                            .join('\n')
                        : undefined
                    }
                  />
                  <Figure
                    label="Average week"
                    value={formatHours(average)}
                    hint="Across weeks with hours in them."
                  />
                  {/* One figure per currency, side by side and never added.
                      There is no exchange rate anywhere in this app, so a
                      combined number would be invented rather than computed. */}
                  {totals.totals.map((total) => (
                    <Figure
                      key={total.currency}
                      label={total.currency}
                      value={formatMoney(total.amount, total.currency)}
                      // The second line is part of the amount above, not an
                      // addition to it.
                      hint={
                        total.tracker_hours > 0
                          ? `${formatHours(total.hours)}\nof which ${formatMoney(
                              total.tracker_amount,
                              total.currency
                            )} not billed yet`
                          : formatHours(total.hours)
                      }
                    />
                  ))}
                </View>

                {totals.totals.length > 1 ? (
                  <Text className="text-xs leading-relaxed text-slate-600">
                    Shown one currency at a time. There is no exchange rate here, so these are
                    never added into a single total.
                  </Text>
                ) : null}

                {totals.non_billable_hours > 0 ? (
                  <Text className="text-xs leading-relaxed text-slate-500">
                    <Text className="tabular-nums text-slate-300">
                      {formatHours(totals.non_billable_hours)}
                    </Text>
                    {' of the total is non-billable and earns nothing.'}
                  </Text>
                ) : null}

                {/* The window's version of the card note: these hours are in
                    the figures above, they are simply not invoiceable yet. */}
                {totals.trackers.outstanding_count > 0 ? (
                  <AmberNote
                    title={
                      totals.trackers.outstanding_count === 1
                        ? '1 tracker in this window is counted here but not billed yet.'
                        : `${totals.trackers.outstanding_count} trackers in this window are counted here but not billed yet.`
                    }
                  >
                    {trackerNoteLines(totals.trackers).join('\n')}
                  </AmberNote>
                ) : null}

                {/* Said once, quietly, next to the figures it qualifies. */}
                <Text className="text-xs leading-relaxed text-slate-600">
                  Estimate — hours × rate only. An invoice can also carry a per-line rate
                  override, a discount and tax, so its total may differ.
                </Text>
              </View>
            </Card>
          ) : null}

          {/* Entries exist, but every one of them rounds to 0.00 h. Distinct
              from "nothing tracked": the entries are real and the hours on them
              are editable, so this points at the entry rather than at the
              tracker. */}
          {trackedButUnmeasured ? (
            <Card>
              <Text className="text-sm text-slate-300">
                {totals.entry_count} time {totals.entry_count === 1 ? 'entry' : 'entries'} in the
                last {weekCount} weeks, and none of them carries any measurable time.
              </Text>
              <Text className="mt-1.5 text-xs leading-relaxed text-slate-500">
                Hours round to two decimal places, so anything under about half a minute reads as
                0.00 h. Set the hours on the entry directly from the Time Entries page.
              </Text>
            </Card>
          ) : null}

          {/* ── Nothing tracked ──
              Genuinely nothing now: no time entries and no tracker time either,
              since an unbilled tracker counts towards `totals.hours` and would
              have kept the window out of this branch. So there is no
              unbilled-tracker note to make here any more — a window with
              trackers in it renders cards. */}
          {nothingTracked ? (
            <EmptyState
              title={`Nothing tracked in the last ${weekCount} weeks.`}
              subtitle="Hours arrive here from time entries and from trackers you have not billed yet — neither has anything in this window. Start a tracker, or add a time entry, and it appears in the week it began."
            />
          ) : null}

          {/* ── One card per week, newest first ──
              A quiet week among busy ones is a real answer and is kept — hiding
              it would make the stretch look denser than it was. A window where
              EVERY week is quiet is a different thing: twelve identical empty
              cards say nothing the message above has not already said better,
              so the list is dropped entirely in that case. */}
          {!nothingTracked
            ? weeks.map((week, index) => (
                <WeekCard
                  key={week.key}
                  week={week}
                  open={openWeeks[week.key] ?? index === 0}
                  onToggle={() => toggleWeek(week.key, index === 0)}
                />
              ))
            : null}
        </>
      )}
    </View>
  );
}
