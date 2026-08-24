// Regenerating an invoice's lines, on the phone.
//
// The port of `front/src/components/RegenerateModal.tsx`. Same two steps, same
// copy, same judgements — configure what to pull from, load a fresh preview,
// then read what applying it would do before applying it.
//
// ── What this screen does NOT do ─────────────────────────────────────────────
//
// It writes nothing. `onApply` hands merged lines back to the editor's draft
// and closes; the user still has to press Save changes on the invoice for any
// of it to reach the server. That is stated on screen too, because "Apply" in a
// sheet that just made a network call reads like a save.
//
// It also does no arithmetic of its own. `mergeRegeneratedLines` decides which
// fields are refreshed and which are preserved, `roundHoursToIncrement` (called
// from inside the merge) does the increment rounding, and `formatHours` does
// the display. Nothing here computes a figure and formats it with `toFixed`
// (CLAUDE.md § Money rules).
//
// ── No locking ───────────────────────────────────────────────────────────────
//
// Nothing below is read-only or disabled on the grounds that a value looks
// wrong. An invoice that is already sent or paid can still be regenerated — it
// draws a warning and nothing more. The only `disabled`/`loading` here is on
// the action button while its request is in flight, which is a double-submit
// guard, not a value lock.
//
// The word "Sessions" appears nowhere: the `sessions` collection is Time
// Entries, and the UI word "Sessions" belongs to `goals`.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { apiErrorMessage, previewInvoice } from '@/api';
import { Button, Chip, DateTimeField, ErrorNote, LoadingBlock } from '@/components';
import { formatHours } from '@/lib/money';
import {
  mergeRegeneratedLines,
  type LineChange,
  type LineChangeKind,
  type MergeResult,
} from '@/lib/regenerate';
import Sheet from '@/screens/now/Sheet';
import type { HoursRoundingDirection, Invoice, InvoicePreviewLine, Project } from '@/types';

import { dayFromFieldValue, type LineDraft } from './draft';
import { draftLinesToInvoiceLines, invoiceLinesToDraftLines } from './regenerateDraft';

// ── Copy and palette ─────────────────────────────────────────────────────────

// Grouped in the order the user reads them: what is new, what moved, what
// disappeared, then the untouched remainder.
const KIND_ORDER: LineChangeKind[] = ['added', 'updated', 'removed', 'unchanged', 'manual'];

const KIND_LABEL: Record<LineChangeKind, string> = {
  added: 'Added',
  updated: 'Updated',
  removed: 'Removed',
  unchanged: 'Unchanged',
  manual: 'Manual lines (kept as-is)',
};

const KIND_BLURB: Record<LineChangeKind, string> = {
  added: 'New work found in this period.',
  updated: 'Hours or dates moved. Your rate, description and task list are kept.',
  removed: 'No longer backed by any time entry in this period. Applying drops these lines.',
  unchanged: 'Nothing to do.',
  manual: 'Added by hand, so nothing regenerates them.',
};

// Colour carries the meaning, following the same good / caution / destructive
// palette the rest of the invoice UI uses. Split into surface and label because
// a React Native `View` does not pass its colour down to the `Text` inside it,
// and written out in full because NativeWind extracts classes from the source
// at build time — an interpolated class compiles to nothing.
const KIND_SURFACE: Record<LineChangeKind, string> = {
  added: 'border-green-400/30 bg-green-400/5',
  updated: 'border-amber-400/30 bg-amber-400/5',
  removed: 'border-red-400/30 bg-red-400/10',
  unchanged: 'border-slate-700 bg-slate-800/40',
  manual: 'border-slate-700 bg-slate-800/40',
};

const KIND_TEXT: Record<LineChangeKind, string> = {
  added: 'text-green-300',
  updated: 'text-amber-300',
  removed: 'text-red-300',
  unchanged: 'text-slate-400',
  manual: 'text-slate-400',
};

/** What the user is told is kept and what is refreshed — shown in both steps. */
const KEPT_BLURB =
  'Your rates, descriptions and task lists are kept. Only hours, dates and which lines exist ' +
  'are refreshed. Nothing is saved until you press Save changes on the invoice.';

/** An hours figure, or a dash where there is none — 'added' has no before. */
function hoursText(value: number | null): string {
  return value === null ? '—' : formatHours(value);
}

// Spell the configured rule out on the toggle itself, so the user knows what
// ticking it does without leaving to read Settings.
function roundingLabel(increment: number, direction: HoursRoundingDirection): string {
  const verb =
    direction === 'up' ? 'Round up to' : direction === 'down' ? 'Round down to' : 'Round to the nearest';
  return `${verb} ${increment} h`;
}

// ── The sheet ────────────────────────────────────────────────────────────────

export interface RegenerateSheetProps {
  open: boolean;
  invoice: Invoice;
  projects: Project[];
  /** The editor's WORKING lines, unsaved edits included — they take part in the merge. */
  currentLines: LineDraft[];
  /** The saved billing increment. Absent or non-positive means rounding is not offered at all. */
  roundingIncrement?: number;
  roundingDirection?: HoursRoundingDirection;
  /** Hands back merged draft lines plus the period the regenerate settled on. Writes nothing. */
  onApply: (lines: LineDraft[], periodStart: string, periodEnd: string) => void;
  onClose: () => void;
}

export default function RegenerateSheet({
  open,
  invoice,
  projects,
  currentLines,
  roundingIncrement,
  roundingDirection,
  onApply,
  onClose,
}: RegenerateSheetProps) {
  const canRound =
    typeof roundingIncrement === 'number' && Number.isFinite(roundingIncrement) && roundingIncrement > 0;
  const direction: HoursRoundingDirection = roundingDirection ?? 'nearest';

  // The period fields hold whatever `DateTimeField` speaks: a bare `YYYY-MM-DD`
  // going in (that is how the invoice stores it) and a full wire timestamp
  // coming back out. `dayFromFieldValue` is what reads a day out of either.
  const [periodStart, setPeriodStart] = useState<string | null>(invoice.period_start);
  const [periodEnd, setPeriodEnd] = useState<string | null>(invoice.period_end);
  const [projectIds, setProjectIds] = useState<string[]>(invoice.project_ids ?? []);
  const [includeTrackers, setIncludeTrackers] = useState(true);
  const [includeInvoiced, setIncludeInvoiced] = useState(false);
  // On by default when an increment is configured: the owner set it precisely
  // so that billed hours land on it, and a regenerate that ignored it would
  // hand back raw figures they would then have to round again by hand.
  const [roundHours, setRoundHours] = useState(canRound);

  // The preview is kept RAW rather than pre-merged, so flipping the rounding
  // toggle re-merges in place instead of sending the user back to Load. The
  // merge is pure and cheap; the network call is neither.
  const [preview, setPreview] = useState<InvoicePreviewLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Re-arm each time the sheet opens, so a second regenerate never starts on
  // the first one's answers. Keyed on the invoice's **id**, not the object:
  // the editor hands back a fresh `Invoice` after every save, and depending on
  // the object would wipe a loaded preview while the user was reading it.
  useEffect(() => {
    if (!open) return;
    setPeriodStart(invoice.period_start);
    setPeriodEnd(invoice.period_end);
    setProjectIds(invoice.project_ids ?? []);
    setIncludeTrackers(true);
    setIncludeInvoiced(false);
    setRoundHours(canRound);
    setPreview(null);
    setError('');
    setLoading(false);
  }, [open, invoice.id, canRound]);

  // The merge speaks `InvoiceLine`; the editor speaks `LineDraft`. This is the
  // only sanctioned crossing, and it goes through `regenerateDraft.ts` in both
  // directions rather than being re-derived here.
  const currentInvoiceLines = useMemo(
    () => draftLinesToInvoiceLines(currentLines),
    [currentLines],
  );

  const result: MergeResult | null = useMemo(() => {
    if (preview === null) return null;
    const rounding =
      roundHours && typeof roundingIncrement === 'number' && roundingIncrement > 0
        ? { increment: roundingIncrement, direction }
        : null;
    return mergeRegeneratedLines(currentInvoiceLines, preview, rounding);
  }, [preview, currentInvoiceLines, roundHours, roundingIncrement, direction]);

  // The client is a snapshot on the invoice and the server will not accept a
  // different one, so it is shown rather than offered.
  const clientProjects = projects.filter((project) => project.client_id === invoice.client_id);

  const startDay = dayFromFieldValue(periodStart);
  const endDay = dayFromFieldValue(periodEnd);
  const periodChanged =
    startDay !== (invoice.period_start ?? null) || endDay !== (invoice.period_end ?? null);
  const periodBackwards = Boolean(startDay && endDay && startDay > endDay);

  const toggleProject = (id: string) => {
    setProjectIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
    setPreview(null); // the summary was built from the old source; drop it
  };

  async function handleLoad() {
    if (!startDay || !endDay) {
      setError('Pick a period.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const fresh = await previewInvoice({
        client_id: invoice.client_id,
        ...(projectIds.length > 0 ? { project_ids: projectIds } : {}),
        period_start: startDay,
        period_end: endDay,
        include_invoiced: includeInvoiced,
        include_trackers: includeTrackers,
        // Without this the invoice's own claims read as "already billed" — by
        // this very invoice — and the preview would come back all but empty,
        // so every line it holds would be reported as removed.
        for_invoice_id: invoice.id,
      });
      setPreview(fresh.lines ?? []);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to load time entries for that period.'));
    } finally {
      setLoading(false);
    }
  }

  function handleApply() {
    // The period stays editable after loading (no locking), so it can have been
    // cleared since — and the period is part of what Apply hands back.
    if (result === null || !startDay || !endDay) {
      setError('Pick a period.');
      return;
    }
    // Nothing is posted. The merged lines become the editor's draft, keeping
    // each surviving row's React key so a focused text input does not jump.
    onApply(invoiceLinesToDraftLines(result.lines, currentLines), startDay, endDay);
    onClose();
  }

  const issued = invoice.status !== 'draft';

  // Rendered in both steps: the summary re-merges the moment it is flipped, so
  // the user can see the rounded and unrounded outcome without reloading.
  // Hidden entirely when no increment is configured — nothing to round to.
  const roundingToggle =
    canRound && roundingIncrement !== undefined ? (
      <CheckRow checked={roundHours} onToggle={() => setRoundHours((prev) => !prev)}>
        <Text className="text-xs text-slate-400">
          Round hours to the billing increment
          <Text className="text-slate-500"> · {roundingLabel(roundingIncrement, direction)}</Text>
        </Text>
      </CheckRow>
    ) : null;

  if (!open) return null;

  return (
    <Sheet
      open={open}
      title={`Regenerate lines · ${invoice.invoice_number}`}
      onClose={onClose}
      testID="regenerate-sheet"
      footer={
        <>
          <Text className="text-xs text-slate-500">
            {result === null
              ? 'Nothing is written to the server here.'
              : `${currentLines.length} line${currentLines.length !== 1 ? 's' : ''} now · ${
                  result.lines.length
                } after applying`}
          </Text>
          <View className="flex-row gap-3">
            <View className="flex-1">
              {/* Step 2's Back returns to the configuration without reloading;
                  step 1 has nothing behind it, so it cancels. Closing outright
                  is the ✕ in the header and the backdrop, which is why there is
                  no third button — 375px does not hold one. */}
              <Button
                label={result === null ? 'Cancel' : 'Back'}
                variant="secondary"
                onPress={result === null ? onClose : () => setPreview(null)}
              />
            </View>
            <View className="flex-1">
              {result === null ? (
                <Button label="Load changes" loading={loading} onPress={handleLoad} />
              ) : result.hasChanges ? (
                <Button label="Apply to invoice" onPress={handleApply} testID="regenerate-apply" />
              ) : (
                /* Already up to date: Apply would be a no-op, so it is not offered. */
                <Button label="Close" variant="secondary" onPress={onClose} />
              )}
            </View>
          </View>
        </>
      }
    >
      {/* Warn on an issued invoice — nothing below is disabled (§ no locking). */}
      {issued ? (
        <Text className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
          This invoice is already marked {invoice.status}. Regenerating changes what it bills, and
          the client may already have the old figures. You can still do it.
        </Text>
      ) : null}

      {result === null ? (
        // ── Step 1: what to pull from ──
        <View className="gap-4">
          <View className="gap-1">
            <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Client
            </Text>
            <Text className="text-sm text-slate-300" numberOfLines={1}>
              {invoice.client_name}
            </Text>
          </View>

          <View className="flex-row gap-3">
            <View className="flex-1">
              <DateTimeField
                label="Period from"
                mode="date"
                value={periodStart}
                onChange={(next) => {
                  setPeriodStart(next);
                  setPreview(null);
                }}
              />
            </View>
            <View className="flex-1">
              <DateTimeField
                label="Period to"
                mode="date"
                value={periodEnd}
                onChange={(next) => {
                  setPeriodEnd(next);
                  setPreview(null);
                }}
                warning={
                  periodBackwards
                    ? 'This period ends before it starts. Allowed — it will simply match nothing.'
                    : undefined
                }
              />
            </View>
          </View>

          {clientProjects.length > 0 ? (
            <View className="gap-2">
              <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Projects
              </Text>
              <Text className="text-xs text-slate-500">
                {projectIds.length === 0
                  ? 'Every project for this client.'
                  : `${projectIds.length} of ${clientProjects.length} selected.`}
              </Text>
              {clientProjects.map((project) => {
                const on = projectIds.includes(project.id);
                return (
                  <Pressable
                    key={project.id}
                    onPress={() => toggleProject(project.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    className={`flex-row items-center gap-3 rounded-lg border px-3 py-2.5 ${
                      on
                        ? 'border-violet-500/50 bg-violet-500/10'
                        : 'border-slate-800 bg-slate-950 active:bg-slate-800'
                    }`}
                  >
                    <Text className={`text-base ${on ? 'text-violet-400' : 'text-slate-600'}`}>
                      {on ? '☑' : '☐'}
                    </Text>
                    <Text className="flex-1 text-sm text-slate-100" numberOfLines={1}>
                      {project.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <View className="gap-1">
            <CheckRow
              checked={includeTrackers}
              onToggle={() => setIncludeTrackers((prev) => !prev)}
            >
              <Text className="text-xs text-slate-400">Include trackers</Text>
            </CheckRow>
            <CheckRow
              checked={includeInvoiced}
              onToggle={() => setIncludeInvoiced((prev) => !prev)}
            >
              <Text className="text-xs text-slate-400">
                Include entries already billed on another invoice
              </Text>
            </CheckRow>
            {roundingToggle}
          </View>

          <Text className="text-xs leading-relaxed text-slate-500">{KEPT_BLURB}</Text>

          {loading ? <LoadingBlock label="Loading time entries…" /> : null}
        </View>
      ) : (
        // ── Step 2: what applying would do ──
        <View className="gap-4">
          {roundingToggle ? (
            <View className="rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2">
              {roundingToggle}
            </View>
          ) : null}
          <ChangeSummary result={result} />
          {periodChanged ? (
            <Text className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
              The period differs from the one stored on this invoice. Applying also updates it to{' '}
              {startDay ?? '—'} – {endDay ?? '—'}, because that is what prints on the document.
            </Text>
          ) : null}
        </View>
      )}

      {error ? <ErrorNote message={error} /> : null}
    </Sheet>
  );
}

// ── Change summary ───────────────────────────────────────────────────────────

function ChangeSummary({ result }: { result: MergeResult }) {
  const delta = result.hoursAfter - result.hoursBefore;
  // Only worth showing once it survives the 2 dp the figure is rendered at.
  // Both totals are sums of floats that came back through JSON, so a bare
  // `!== 0` prints "(+0.00 h)" for pure noise.
  const deltaShown = Math.abs(delta) >= 0.005;

  if (!result.hasChanges) {
    return (
      <View className="gap-2">
        <Text className="text-sm leading-relaxed text-slate-300">
          This invoice is already up to date — the current time entries produce exactly the lines
          it already has.
        </Text>
        <Text className="text-xs text-slate-500">
          {hoursText(result.hoursBefore)} across {result.lines.length} line
          {result.lines.length !== 1 ? 's' : ''}.
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-4">
      {/* The headline number, before anything is read line by line. */}
      <View className="flex-row flex-wrap items-baseline gap-2">
        <Text className="text-sm text-slate-400">Total hours</Text>
        <Text className="text-base tabular-nums text-slate-300">
          {hoursText(result.hoursBefore)}
        </Text>
        <Text className="text-slate-500">→</Text>
        <Text
          className={`text-base font-semibold tabular-nums ${
            delta > 0 ? 'text-green-300' : delta < 0 ? 'text-red-300' : 'text-slate-200'
          }`}
        >
          {hoursText(result.hoursAfter)}
        </Text>
        {deltaShown ? (
          <Text
            className={`text-xs tabular-nums ${delta > 0 ? 'text-green-400/80' : 'text-red-400/80'}`}
          >
            ({delta > 0 ? '+' : '−'}
            {formatHours(Math.abs(delta))})
          </Text>
        ) : null}
      </View>

      <Text className="text-xs leading-relaxed text-slate-500">{KEPT_BLURB}</Text>

      {/* Dropping lines is the one irreversible-feeling outcome here, so it is
          called out above the list as well as coloured inside it. */}
      {result.counts.removed > 0 ? (
        <View className="flex-row items-start gap-2.5 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2.5">
          <Text className="text-sm text-red-400">⚠</Text>
          <Text className="flex-1 text-xs leading-relaxed text-red-300">
            {result.counts.removed}{' '}
            {result.counts.removed === 1 ? 'line will be removed' : 'lines will be removed'} from
            this invoice. Their hours stop being billed here. Check the red group below before
            applying.
          </Text>
        </View>
      ) : null}

      {KIND_ORDER.map((kind) => {
        const group = result.changes.filter((change) => change.kind === kind);
        if (group.length === 0) return null;
        return (
          <View key={kind} className="gap-1.5">
            <View className="flex-row items-baseline gap-2">
              <Text className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {KIND_LABEL[kind]}
              </Text>
              <Text className="text-xs text-slate-600">{group.length}</Text>
            </View>
            <Text className="text-xs leading-snug text-slate-600">{KIND_BLURB[kind]}</Text>
            <View className="gap-1">
              {group.map((change, index) => (
                // `line_id` is empty on a line added on the phone and the
                // preview mints a fresh one on every run, so neither is unique
                // across this list — the group name plus position is.
                <ChangeRow key={`${kind}-${index}-${change.line.line_id}`} change={change} />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function ChangeRow({ change }: { change: LineChange }) {
  const tone = KIND_TEXT[change.kind];

  return (
    <View
      className={`flex-row items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
        KIND_SURFACE[change.kind]
      }`}
    >
      <View className="flex-1">
        <View className="flex-row items-center gap-1.5">
          <Text className={`flex-1 text-sm ${tone}`} numberOfLines={1}>
            {change.title || 'Untitled line'}
          </Text>
          {change.isTracker ? <Chip label="tracker" tone="violet" size="sm" /> : null}
        </View>
        {change.datesChanged ? (
          <Text className={`mt-0.5 text-xs opacity-80 ${tone}`} numberOfLines={1}>
            Dates change to {change.line.date_from ?? '—'} – {change.line.date_to ?? '—'}
          </Text>
        ) : null}
      </View>

      <Text className={`shrink-0 text-xs tabular-nums ${tone}`}>
        {change.kind === 'updated'
          ? `${hoursText(change.hoursBefore)} → ${hoursText(change.hoursAfter)}`
          : change.kind === 'removed'
            ? hoursText(change.hoursBefore)
            : hoursText(change.hoursAfter ?? change.hoursBefore)}
      </Text>
    </View>
  );
}

// ── A tick row ───────────────────────────────────────────────────────────────

/**
 * The web's `<input type="checkbox">` with its label, as a single finger-sized
 * target. The glyph is text because this app ships no icon library.
 */
function CheckRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      className="flex-row items-center gap-3 py-2"
    >
      <Text className={`text-base ${checked ? 'text-violet-400' : 'text-slate-600'}`}>
        {checked ? '☑' : '☐'}
      </Text>
      <View className="flex-1">{children}</View>
    </Pressable>
  );
}
