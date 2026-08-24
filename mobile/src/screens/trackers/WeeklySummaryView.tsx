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
//   2. The unbilled-tracker note is the most important thing on a card. Every
//      figure here comes from time entries, because a tracker has no project
//      and therefore no rate to price it with. A tracker you stopped but never
//      billed contributes nothing — so without this note the week silently
//      reads low, and reads low in precisely the situation you opened this view
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
              <View key={total.currency} className="flex-row items-baseline gap-2">
                <Text className="text-base font-medium tabular-nums text-slate-100">
                  {formatMoney(total.amount, total.currency)}
                </Text>
                <Text className="min-w-0 flex-1 text-xs text-slate-500" numberOfLines={1}>
                  {total.currency} · {formatHours(total.hours)}
                </Text>
              </View>
            ))}
          </View>
        ) : week.hours > 0 ? (
          <Text className="text-xs leading-relaxed text-slate-500">
            Nothing billable — every time entry this week is marked non-billable.
          </Text>
        ) : null}

        {/* ── Unbilled trackers ──
            The one note that changes what the numbers above MEAN. These hours
            are absent from every figure on this card, so the card reads low
            until they are billed. Written as an explanation and a next step,
            not as an error: not billing a tracker yet is normal. */}
        {week.unbilled.count > 0 ? (
          <AmberNote
            title={
              week.unbilled.count === 1
                ? '1 tracker stopped this week was never billed into time entries.'
                : `${week.unbilled.count} trackers stopped this week were never billed into time entries.`
            }
          >
            {`Roughly ${formatHours(week.unbilled.hours)} of elapsed tracker time is missing from every figure on this card, so the week reads low. Bill the tracker from the Trackers tab and its hours appear here.`}
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
  // Keyed on `entry_count`, not on `hours === 0`: those two come apart when
  // every entry in the window rounds to 0.00 h, and saying "no time entries
  // fall in the last N weeks" over a window that has some would be a plain
  // falsehood. The two cases get different copy below.
  const nothingTracked = weeks.length === 0 || totals.entry_count === 0;
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
                  <Figure label="Total hours" value={formatHours(totals.hours)} />
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
                      hint={formatHours(total.hours)}
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

          {/* ── Nothing tracked ── */}
          {nothingTracked ? (
            <View className="gap-3">
              <EmptyState
                title={`No time entries fall in the last ${weekCount} weeks.`}
                subtitle="Hours only reach this view once a tracker has been billed into time entries — a tracker on its own is a grouping and carries no rate to price it with. Bill one from the Trackers tab and its hours appear in the week it started."
              />

              {/* The likeliest reason the window is empty, so it belongs here
                  and not only on the individual cards below. */}
              {totals.unbilled.count > 0 ? (
                <AmberNote
                  title={
                    totals.unbilled.count === 1
                      ? '1 stopped tracker in this window was never billed into time entries.'
                      : `${totals.unbilled.count} stopped trackers in this window were never billed into time entries.`
                  }
                >
                  {`That is roughly ${formatHours(totals.unbilled.hours)} of elapsed tracker time not counted anywhere on this view.`}
                </AmberNote>
              ) : null}
            </View>
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
