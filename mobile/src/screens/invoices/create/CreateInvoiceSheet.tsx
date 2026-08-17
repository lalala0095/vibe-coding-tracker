// Building a new invoice: pick a client and a period, preview what would be
// billed, tick the lines, create.
//
// ── What this screen is allowed to compute ───────────────────────────────────
//
// Nothing that gets sent. Every money field on an invoice is recomputed by the
// server on write and client-supplied totals are ignored (CLAUDE.md, § Money
// rules). `computeMoney` is used here for one thing only — the running subtotal
// and hours under the tick list, so the footer describes the lines that are
// actually ticked rather than re-adding the preview's own figures, which stop
// describing the invoice the moment a line is unticked. None of its output
// reaches `createInvoice`.
//
// ── Dates ────────────────────────────────────────────────────────────────────
//
// `period_start`, `period_end`, `issue_date` and `due_date` are bare
// `YYYY-MM-DD`. They are derived through `src/lib/sgt.ts` and `./dates.ts`;
// `.toISOString()` appears nowhere, because it returns the UTC day and would
// date a Singapore evening a day early. See the header of `./dates.ts`.
//
// ── No locking ───────────────────────────────────────────────────────────────
//
// No field below is ever read-only. A line the preview flagged as a duplicate
// is still tickable, a period that runs backwards is still submittable, and a
// tax percent can be anything. Each draws a note. The only `disabled` on the
// screen is on the two action buttons, which is a submit guard, not a value
// lock.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  apiErrorMessage,
  createInvoice,
  getClients,
  getInvoiceSettings,
  getProjects,
  previewInvoice,
} from '@/api';
import {
  Button,
  LoadingBlock,
  NumberField,
  Select,
  TextField,
  DateTimeField,
  parseNumberInput,
  type SelectOption,
} from '@/components';
import { computeMoney, formatHours } from '@/lib/money';
import { todaySgt } from '@/lib/sgt';
import { money } from '@/screens/invoices/invoiceMeta';
import Sheet from '@/screens/now/Sheet';
import type {
  Client,
  CreateInvoicePayload,
  Invoice,
  InvoicePreviewResponse,
  InvoiceSettings,
  Project,
} from '@/types';

import PreviewLineRow from './PreviewLineRow';
import { addDays, dayOf, startOfMonthSgt } from './dates';
import { clearable, toInvoiceLine } from './payload';

export interface CreateInvoiceSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The created invoice, straight from the server. */
  onCreated: (invoice: Invoice) => void;
}

const DEFAULT_DUE_DAYS = 14;

export default function CreateInvoiceSheet({
  visible,
  onClose,
  onCreated,
}: CreateInvoiceSheetProps) {
  // ── Reference data ──────────────────────────────────────────────────────────
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<InvoiceSettings | null>(null);
  const [loadingClients, setLoadingClients] = useState(false);
  const [clientsError, setClientsError] = useState('');

  // ── What the preview is built from ──────────────────────────────────────────
  const [clientId, setClientId] = useState<string | null>(null);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [periodStart, setPeriodStart] = useState<string | null>(startOfMonthSgt);
  const [periodEnd, setPeriodEnd] = useState<string | null>(todaySgt);
  const [includeTrackers, setIncludeTrackers] = useState(true);
  const [includeInvoiced, setIncludeInvoiced] = useState(false);

  // ── The preview itself ──────────────────────────────────────────────────────
  const [preview, setPreview] = useState<InvoicePreviewResponse | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [stale, setStale] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // ── Invoice details, defaulted from settings ────────────────────────────────
  const [currency, setCurrency] = useState('');
  // The preview resolves the currency from the client, which is more specific
  // than the settings default this field starts on — so a preview overwrites
  // that default, but never something the user typed here themselves.
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [issueDate, setIssueDate] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [taxLabel, setTaxLabel] = useState('');
  const [taxPercent, setTaxPercent] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Load, and reset, each time the sheet opens ──────────────────────────────
  // A create sheet that reopens still showing the last invoice's ticked lines
  // is the one way this screen could bill the wrong thing without anyone
  // touching it, so everything derived is cleared here.
  const applySettings = useCallback((loaded: InvoiceSettings | null) => {
    const today = todaySgt();
    setSettings(loaded);
    setCurrency(loaded?.default_currency ?? '');
    setCurrencyTouched(false);
    setIssueDate(today);
    setDueDate(addDays(today, loaded?.default_due_days ?? DEFAULT_DUE_DAYS));
    setTaxLabel(loaded?.default_tax_label ?? '');
    setTaxPercent(loaded?.default_tax_percent ? String(loaded.default_tax_percent) : '');
    setPaymentTerms(loaded?.default_payment_terms ?? '');
  }, []);

  useEffect(() => {
    if (!visible) return;

    setClientId(null);
    setProjectIds([]);
    setProjects([]);
    setPeriodStart(startOfMonthSgt());
    setPeriodEnd(todaySgt());
    setIncludeTrackers(true);
    setIncludeInvoiced(false);
    setPreview(null);
    setExcluded(new Set());
    setStale(false);
    setNotes('');
    setError('');
    setSaving(false);

    setLoadingClients(true);
    setClientsError('');
    getClients()
      .then(setClients)
      .catch((e) => setClientsError(apiErrorMessage(e, 'Could not load your clients.')))
      .finally(() => setLoadingClients(false));

    // Best effort. Settings only supply defaults the user can see and change,
    // so a failure here costs the pre-fill and never the invoice: the server
    // applies its own defaults for anything the payload omits.
    getInvoiceSettings()
      .then(applySettings)
      .catch(() => applySettings(null));
  }, [visible, applySettings]);

  // Projects belong to the chosen client, so they are fetched per client rather
  // than all at once.
  useEffect(() => {
    if (!visible || !clientId) {
      setProjects([]);
      return;
    }
    getProjects(clientId)
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [visible, clientId]);

  // Anything the preview was built FROM invalidates the lines it produced.
  // Without this, switching client after a preview would leave the previous
  // client's lines on screen, and creating would stamp this client's invoice
  // number onto the other client's time entries.
  const invalidate = useCallback(() => {
    setStale((was) => was || preview !== null);
    setPreview(null);
    setExcluded(new Set());
  }, [preview]);

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === clientId) ?? null,
    [clients, clientId],
  );

  const clientOptions: SelectOption[] = useMemo(
    () =>
      clients.map((client) => ({
        label: client.name,
        value: client.id,
        sublabel: client.default_rate !== null
          ? `${client.currency} · default rate ${client.default_rate}`
          : client.currency,
      })),
    [clients],
  );

  const startDay = dayOf(periodStart);
  const endDay = dayOf(periodEnd);
  const issueDay = dayOf(issueDate);
  const dueDay = dayOf(dueDate);

  const lines = preview?.lines ?? [];
  const includedLines = useMemo(
    () => lines.filter((line) => !excluded.has(line.line_id)),
    [lines, excluded],
  );

  // Display only — see the header. Discount is left off the create sheet, so
  // this is the subtotal before any discount or tax the invoice later carries.
  const totals = useMemo(() => computeMoney(includedLines), [includedLines]);

  const shownCurrency =
    currency.trim() || preview?.currency || selectedClient?.currency || 'USD';

  const flaggedTicked = includedLines.filter((line) => line.include_by_default === false).length;

  const toggleProject = (id: string) => {
    setProjectIds((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id],
    );
    invalidate();
  };

  const toggleLine = (lineId: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  };

  async function handlePreview() {
    if (!clientId) {
      setError('Pick a client first.');
      return;
    }
    if (!startDay || !endDay) {
      setError('Pick both ends of the period.');
      return;
    }

    setPreviewing(true);
    setError('');
    try {
      const result = await previewInvoice({
        client_id: clientId,
        ...(projectIds.length > 0 ? { project_ids: projectIds } : {}),
        period_start: startDay,
        period_end: endDay,
        include_invoiced: includeInvoiced,
        include_trackers: includeTrackers,
      });

      const previewLines = result.lines ?? [];
      setPreview({ ...result, lines: previewLines });
      // Only an explicit `false` starts unticked. A line from an older server
      // that omits the field stays included, which is what task lines have
      // always done.
      setExcluded(
        new Set(
          previewLines
            .filter((line) => line.include_by_default === false)
            .map((line) => line.line_id),
        ),
      );
      if (result.currency && !currencyTouched) setCurrency(result.currency);
      setStale(false);
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load what is billable for that period.'));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCreate() {
    if (!clientId) {
      setError('Pick a client first.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const payload: CreateInvoicePayload = {
        client_id: clientId,
        project_ids: projectIds,
        issue_date: issueDay,
        period_start: startDay,
        period_end: endDay,
        // Omitted when blank so the server resolves it from the client. Never
        // sent as the "null" sentinel — see the note in `payload.ts`.
        ...(currency.trim() ? { currency: currency.trim().toUpperCase() } : {}),
        // Only the ticked lines are billed. Unticking is the whole point of the
        // list, so the excluded ones are dropped here rather than sent.
        lines: includedLines.map(toInvoiceLine),
        // An emptied field means "none", so it sends the sentinel rather than
        // being omitted — omitting takes the settings default instead.
        due_date: clearable(dueDay),
        tax_label: clearable(taxLabel),
        tax_percent: parseNumberInput(taxPercent) ?? 0,
        payment_terms: clearable(paymentTerms),
        notes: clearable(notes),
      };

      const created = await createInvoice(payload);
      onCreated(created);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not create the invoice.'));
      setSaving(false);
    }
  }

  if (!visible) return null;

  const periodBackwards = Boolean(startDay && endDay && startDay > endDay);

  return (
    <Sheet
      open={visible}
      title="New invoice"
      onClose={onClose}
      footer={
        <>
          {error ? <Text className="text-xs text-red-400">{error}</Text> : null}
          <Text className="text-xs text-slate-500">
            {preview
              ? `${includedLines.length} of ${lines.length} line${
                  lines.length === 1 ? '' : 's'
                } · ${formatHours(totals.total_hours)} · ${money(
                  totals.subtotal,
                  shownCurrency,
                )} before discount and tax`
              : 'The server assigns the invoice number on save.'}
          </Text>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button label="Cancel" variant="secondary" onPress={onClose} />
            </View>
            <View className="flex-1">
              <Button
                label="Create invoice"
                loading={saving}
                // Submit guard: there is nothing to POST without a client and a
                // preview. Every field above stays editable regardless.
                disabled={!clientId || preview === null}
                onPress={handleCreate}
              />
            </View>
          </View>
        </>
      }
    >
      {/* ── Who and when ── */}
      {loadingClients ? (
        <LoadingBlock label="Loading clients…" />
      ) : (
        <Select
          label="Client"
          value={clientId}
          onChange={(next) => {
            setClientId(next);
            setProjectIds([]);
            invalidate();
          }}
          options={clientOptions}
          placeholder="Pick a client"
          emptyLabel="No clients yet. Add one on the Clients tab first."
          error={clientsError || undefined}
        />
      )}

      {clientId && projects.length > 0 ? (
        <View className="gap-2">
          <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Projects
          </Text>
          <Text className="text-xs text-slate-500">
            {projectIds.length === 0
              ? 'Every project for this client.'
              : `${projectIds.length} of ${projects.length} selected.`}
          </Text>
          {projects.map((project) => {
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
                {project.rate !== null ? (
                  <Text className="text-xs tabular-nums text-slate-500">{project.rate}/h</Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View className="flex-row gap-3">
        <View className="flex-1">
          <DateTimeField
            label="Period from"
            mode="date"
            value={periodStart}
            onChange={(next) => {
              setPeriodStart(next);
              invalidate();
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
              invalidate();
            }}
            warning={
              periodBackwards
                ? 'This period ends before it starts. Allowed — it will simply match nothing.'
                : undefined
            }
          />
        </View>
      </View>

      <View className="gap-2">
        <Toggle
          checked={includeTrackers}
          onPress={() => {
            setIncludeTrackers((prev) => !prev);
            invalidate();
          }}
          label="Offer trackers as their own lines"
          detail="Billed from elapsed time, alongside the lines built from time entries."
        />
        <Toggle
          checked={includeInvoiced}
          onPress={() => {
            setIncludeInvoiced((prev) => !prev);
            invalidate();
          }}
          label="Include time already invoiced"
          detail="Off by default. On, anything already billed elsewhere is offered again and flagged."
        />
      </View>

      <Button
        label={preview ? 'Preview again' : 'Preview lines'}
        variant="secondary"
        loading={previewing}
        disabled={!clientId}
        onPress={handlePreview}
      />

      {stale && !preview ? (
        <Text className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
          The previous preview no longer matches what you have selected, so it was cleared.
          Preview again.
        </Text>
      ) : null}

      {/* ── What would be billed ── */}
      {preview ? (
        <View className="gap-3">
          <View className="flex-row items-baseline justify-between">
            <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Lines
            </Text>
            <Text className="text-xs tabular-nums text-slate-500">
              {formatHours(preview.total_hours)} previewed ·{' '}
              {money(preview.subtotal, shownCurrency)}
            </Text>
          </View>

          {lines.length === 0 ? (
            <Text className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-sm text-slate-400">
              Nothing billable in that period. Widen the dates, or check the time entries are
              marked billable.
            </Text>
          ) : (
            lines.map((line) => (
              <PreviewLineRow
                key={line.line_id}
                line={line}
                currency={shownCurrency}
                included={!excluded.has(line.line_id)}
                onToggle={() => toggleLine(line.line_id)}
              />
            ))
          )}

          {preview.running_entry_count > 0 ? (
            <Note>
              {preview.running_entry_count === 1
                ? '1 time entry in this period is still running, so it has no hours yet and is not on any line. Stop it, or set its hours, and preview again.'
                : `${preview.running_entry_count} time entries in this period are still running, so they have no hours yet and are on no line. Stop them, or set their hours, and preview again.`}
            </Note>
          ) : null}

          {preview.claimed_entry_count > 0 ? (
            <Note>
              {preview.claimed_entry_count === 1
                ? '1 time entry here is already billed on another invoice.'
                : `${preview.claimed_entry_count} time entries here are already billed on another invoice.`}{' '}
              Ticking those lines bills them a second time. Nothing stops you — the flagged lines
              say which.
            </Note>
          ) : null}

          {preview.duplicate_tracker_count > 0 ? (
            <Note>
              {preview.duplicate_tracker_count === 1
                ? '1 tracker line covers the same ground as the task lines above it'
                : `${preview.duplicate_tracker_count} tracker lines cover the same ground as the task lines above them`}
              , so {preview.duplicate_tracker_count === 1 ? 'it starts' : 'they start'} unticked.
              Tick {preview.duplicate_tracker_count === 1 ? 'it' : 'them'} and the hours are billed
              twice.
            </Note>
          ) : null}

          {preview.tracker_line_count > 0 ? (
            <Text className="text-xs text-slate-500">
              {preview.tracker_line_count} of these{' '}
              {preview.tracker_line_count === 1 ? 'lines comes' : 'lines come'} from a tracker
              rather than from time entries.
            </Text>
          ) : null}

          {flaggedTicked > 0 ? (
            <Note>
              {flaggedTicked === 1
                ? '1 flagged line is ticked and will be billed.'
                : `${flaggedTicked} flagged lines are ticked and will be billed.`}{' '}
              That is your call — nothing here is capped or dropped to make the numbers tidy.
            </Note>
          ) : null}

          {lines.length > 0 && includedLines.length === 0 ? (
            <Note>
              Every line is unticked, so this invoice would be created empty. It can still be
              saved, and lines can be added to it afterwards.
            </Note>
          ) : null}
        </View>
      ) : null}

      {/* ── The invoice's own details ── */}
      <View className="gap-4 border-t border-slate-800 pt-4">
        <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Invoice details
        </Text>

        {settings === null ? (
          <Text className="text-xs text-slate-500">
            Your invoice settings could not be loaded, so these start empty and the server applies
            its own defaults for anything left blank.
          </Text>
        ) : null}

        <View className="flex-row gap-3">
          <View className="flex-1">
            <DateTimeField
              label="Issue date"
              mode="date"
              value={issueDate}
              onChange={setIssueDate}
            />
          </View>
          <View className="flex-1">
            <DateTimeField
              label="Due date"
              mode="date"
              value={dueDate}
              onChange={setDueDate}
              clearable
              warning={
                dueDay && issueDay && dueDay < issueDay
                  ? 'This falls before the issue date. Saved as entered.'
                  : undefined
              }
            />
          </View>
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1">
            <TextField
              label="Currency"
              value={currency}
              onChangeText={(next) => {
                setCurrencyTouched(true);
                setCurrency(next);
              }}
              placeholder={selectedClient?.currency || 'USD'}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={8}
              hint={
                currency.trim()
                  ? undefined
                  : "Blank takes the client's own currency."
              }
            />
          </View>
          <View className="flex-1">
            <NumberField
              label="Tax %"
              value={taxPercent}
              onChangeText={setTaxPercent}
              suffix="%"
              placeholder="0"
            />
          </View>
        </View>

        <TextField
          label="Tax label"
          value={taxLabel}
          onChangeText={setTaxLabel}
          placeholder="GST, VAT, …"
          autoCapitalize="characters"
        />

        <TextField
          label="Payment terms"
          value={paymentTerms}
          onChangeText={setPaymentTerms}
          placeholder="Net 14"
        />

        <TextField
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          multiline
          numberOfLines={3}
          placeholder="Anything the client should read on the invoice"
        />
      </View>

      <Text className="text-xs text-slate-500">
        Every figure here is recomputed by the server when it saves. Hours, rates and amounts stay
        editable on the invoice afterwards.
      </Text>
    </Sheet>
  );
}

// ── Small local pieces ────────────────────────────────────────────────────────

function Toggle({
  checked,
  onPress,
  label,
  detail,
}: {
  checked: boolean;
  onPress: () => void;
  label: string;
  detail: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      className="flex-row items-start gap-3 py-1"
    >
      <Text className={`text-base ${checked ? 'text-violet-400' : 'text-slate-600'}`}>
        {checked ? '☑' : '☐'}
      </Text>
      <View className="flex-1">
        <Text className="text-sm text-slate-100">{label}</Text>
        <Text className="text-xs text-slate-500">{detail}</Text>
      </View>
    </Pressable>
  );
}

/** An amber note. It says something is worth seeing; it never blocks anything. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <Text className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
      {children}
    </Text>
  );
}
