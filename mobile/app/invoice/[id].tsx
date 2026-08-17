// One invoice: what it says, and everything that can be changed about it.
//
// ── The money discipline this screen keeps ───────────────────────────────────
//
// The server owns every monetary figure. `amount` per line, `subtotal`,
// `discount_amount`, `tax_amount`, `total` and `total_hours` are recomputed on
// every write from `hours`, `rate` and the discount/tax settings, and any
// totals sent are ignored — `InvoiceLineInput` has no `amount` field at all.
//
// So there are exactly two sources of a number on this screen:
//
//   clean draft   the invoice as loaded. Every figure is the server's, printed
//                 verbatim. `computeMoney` is not called for display at all.
//   dirty draft   the figures are the *preview* of an unsaved edit, from
//                 `src/lib/money.ts` — a verbatim copy of `front/src/lib/
//                 money.ts` — so the number on screen matches what the server
//                 will compute. Every preview is labelled as unsaved.
//
// The moment a save returns, the response replaces both the invoice and the
// draft, and the preview is gone. A stored figure is never re-derived: a
// historical invoice reads the numbers it was saved with, whatever has happened
// to rates or settings since.
//
// ── No locking ───────────────────────────────────────────────────────────────
//
// Hours, rates, dates and amounts stay editable on a sent invoice and on a paid
// one. `back/routers/invoices.py` says the same thing from the server side:
// *"A sent or paid invoice is editable like any other; status never blocks a
// change."* The only `disabled` on this screen is on submit buttons while their
// request is in flight, which is a double-submit guard rather than a value lock.
//
// ── Dates ────────────────────────────────────────────────────────────────────
//
// `issue_date`, `due_date`, `period_*`, `date_from` and `date_to` are all bare
// `YYYY-MM-DD`. Nothing here calls `.toISOString()`; day values go through
// `dayFromFieldValue`, which reads the Singapore calendar date via
// `src/lib/sgt.ts`.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import {
  apiErrorMessage,
  deleteInvoice,
  getInvoice,
  updateInvoice,
  updateInvoiceStatus,
} from '@/api';
import {
  Button,
  ConfirmSheet,
  EmptyState,
  ErrorNote,
  LoadingBlock,
  Screen,
} from '@/components';
import AdjustmentsCard from '@/screens/invoices/detail/AdjustmentsCard';
import HeaderCard from '@/screens/invoices/detail/HeaderCard';
import LineCard from '@/screens/invoices/detail/LineCard';
import MetaCard from '@/screens/invoices/detail/MetaCard';
import TotalsCard from '@/screens/invoices/detail/TotalsCard';
import {
  blankLine,
  draftFromInvoice,
  isDirty,
  isOverDiscounted,
  previewTotals,
  toUpdatePayload,
  type InvoiceDraft,
  type LineDraft,
} from '@/screens/invoices/detail/draft';
import {
  invoiceDeletionDetail,
  invoiceDeletionMessage,
} from '@/screens/invoices/detail/deletion';
import PaymentsPanel from '@/screens/invoices/payments/PaymentsPanel';
import type { Invoice, InvoiceStatus } from '@/types';

/**
 * `app/_layout.tsx` gives a header only to route names it holds a title for,
 * and that map does not know about this route. Options set from inside a route
 * are layered over the layout's `screenOptions`, so this is where the title and
 * the back arrow come from. Hoisted because `<Stack.Screen>` re-runs its
 * `setOptions` effect whenever the object identity changes.
 */
const SCREEN_OPTIONS = { headerShown: true, title: 'Invoice' };

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // ── Fetching ─────────────────────────────────────────────────────────────

  /**
   * `keepDraft` is what makes pull-to-refresh safe mid-edit: a refresh brings
   * the stored figures up to date without throwing away what is being typed.
   * The draft is reset from the response only when there was nothing unsaved
   * in it.
   */
  const load = useCallback(
    async (options?: { silent?: boolean; keepDraft?: boolean }) => {
      if (!id) return;
      if (!options?.silent) setLoading(true);
      setError('');
      try {
        const fetched = await getInvoice(id);
        setInvoice(fetched);
        if (!options?.keepDraft) setDraft(draftFromInvoice(fetched));
      } catch (e: unknown) {
        setError(apiErrorMessage(e, 'Could not load this invoice.'));
      } finally {
        setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    load();
  }, [load]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const dirty = useMemo(
    () => (invoice && draft ? isDirty(draft, invoice) : false),
    [draft, invoice],
  );

  /**
   * The live preview of the draft.
   *
   * Computed unconditionally because the hook cannot be conditional, but it is
   * *used* only while the draft is dirty — see `amountFor` and the totals
   * block. On a clean draft it would equal the server's figures anyway; showing
   * the stored ones regardless is the rule this screen is built around.
   */
  const preview = useMemo(() => (draft ? previewTotals(draft) : null), [draft]);

  // Read off whichever figures are on screen — the preview while editing, the
  // stored ones otherwise. An invoice already saved with a discount larger than
  // its subtotal keeps the warning; the condition is about the numbers, not
  // about whether an edit is in progress.
  const overDiscounted =
    dirty && preview
      ? isOverDiscounted(preview)
      : invoice !== null && isOverDiscounted(invoice);

  const previewAmounts = useMemo(() => {
    const byKey: Record<string, number> = {};
    for (const line of preview?.lines ?? []) byKey[line.key] = line.amount;
    return byKey;
  }, [preview]);

  const storedAmounts = useMemo(() => {
    const byId: Record<string, number> = {};
    for (const line of invoice?.lines ?? []) byId[line.line_id] = line.amount;
    return byId;
  }, [invoice]);

  /** The stored amount while clean, the preview while not. Never a third thing. */
  const amountFor = (line: LineDraft): number =>
    dirty ? (previewAmounts[line.key] ?? 0) : (storedAmounts[line.line_id] ?? 0);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await load({ silent: true, keepDraft: dirty });
    setRefreshing(false);
  }, [load, dirty]);

  // ── Editing ──────────────────────────────────────────────────────────────

  const patchDraft = (patch: Partial<InvoiceDraft>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  const patchLine = (key: string, patch: Partial<LineDraft>) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            lines: prev.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
          }
        : prev,
    );

  const addLine = () =>
    setDraft((prev) => (prev ? { ...prev, lines: [...prev.lines, blankLine()] } : prev));

  // Removed from the draft only. Nothing leaves the invoice — and no time entry
  // is unlinked — until the save lands and the server reconciles the back-links.
  const removeLine = (key: string) =>
    setDraft((prev) =>
      prev ? { ...prev, lines: prev.lines.filter((line) => line.key !== key) } : prev,
    );

  const handleSave = async () => {
    if (!invoice || !draft) return;
    setSaving(true);
    setSaveError('');
    try {
      const updated = await updateInvoice(invoice.id, toUpdatePayload(draft));
      // The response is the truth: every money field on it was recomputed
      // server-side. Both the invoice and the draft are rebuilt from it, which
      // is what retires the preview.
      setInvoice(updated);
      setDraft(draftFromInvoice(updated));
    } catch (e: unknown) {
      setSaveError(apiErrorMessage(e, 'Could not save this invoice.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (invoice) setDraft(draftFromInvoice(invoice));
    setSaveError('');
  };

  /**
   * Status travels on its own endpoint, so it lands immediately and does not
   * wait on — or carry — the unsaved edits. The draft is deliberately left
   * alone: marking an invoice sent must not discard what is being typed.
   */
  const handleStatusChange = async (status: InvoiceStatus) => {
    if (!invoice || status === invoice.status) return;
    setStatusBusy(true);
    setStatusError('');
    try {
      setInvoice(await updateInvoiceStatus(invoice.id, status));
    } catch (e: unknown) {
      setStatusError(apiErrorMessage(e, 'Could not change the status.'));
    } finally {
      setStatusBusy(false);
    }
  };

  // Throws on failure so `ConfirmSheet` keeps itself open and says what went
  // wrong, rather than closing over an invoice that is still there.
  const handleDelete = async () => {
    if (!invoice) return;
    await deleteInvoice(invoice.id);
    router.back();
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const body = () => {
    if (loading) return <LoadingBlock label="Loading invoice…" />;
    if (error) return <ErrorNote message={error} onRetry={() => load()} />;
    if (!invoice || !draft) {
      return (
        <EmptyState
          title="Invoice not found"
          subtitle="It may have been deleted from another device."
        />
      );
    }

    const currency = invoice.currency || 'USD';
    const discountLabel =
      draft.discount_type === 'percent'
        ? `Discount (${draft.discount_value || '0'}%)`
        : 'Discount';
    const taxLabel = (invoice.tax_label ?? '').trim() || 'Tax';

    return (
      <>
        <HeaderCard
          invoice={invoice}
          onStatusChange={handleStatusChange}
          statusBusy={statusBusy}
        />
        {statusError ? <ErrorNote message={statusError} /> : null}

        <View className="gap-3">
          <View className="flex-row items-baseline justify-between">
            <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Lines
            </Text>
            <Text className="text-xs text-slate-500">
              {draft.lines.length} {draft.lines.length === 1 ? 'line' : 'lines'}
            </Text>
          </View>

          {draft.lines.length === 0 ? (
            <Text className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-6 text-center text-sm text-slate-500">
              No lines. This invoice totals nothing until one is added.
            </Text>
          ) : (
            draft.lines.map((line) => (
              <LineCard
                key={line.key}
                line={line}
                onChange={(patch) => patchLine(line.key, patch)}
                onRemove={() => removeLine(line.key)}
                amount={amountFor(line)}
                preview={dirty}
                currency={currency}
              />
            ))
          )}

          <Button label="+ Add a line" onPress={addLine} variant="secondary" testID="add-line" />
        </View>

        <AdjustmentsCard
          draft={draft}
          onChange={patchDraft}
          currency={currency}
          overDiscounted={overDiscounted}
        />

        <TotalsCard
          currency={currency}
          // The one branch that matters on this screen: the server's stored
          // figures while clean, the `computeMoney` preview while not.
          subtotal={dirty && preview ? preview.subtotal : invoice.subtotal}
          discountAmount={dirty && preview ? preview.discount_amount : invoice.discount_amount}
          taxAmount={dirty && preview ? preview.tax_amount : invoice.tax_amount}
          total={dirty && preview ? preview.total : invoice.total}
          totalHours={dirty && preview ? preview.total_hours : invoice.total_hours}
          discountLabel={discountLabel}
          taxLabel={taxLabel}
          preview={dirty}
          overDiscounted={overDiscounted}
        />

        <MetaCard draft={draft} onChange={patchDraft} issueDate={invoice.issue_date || ''} />

        {/*
          Owned by another workstream and mounted against the agreed contract.
          Payments change `amount_paid`, `outstanding` and `effective_rate`, all
          recomputed server-side, so it hands back the whole invoice.
        */}
        <PaymentsPanel invoice={invoice} onInvoiceChange={setInvoice} />

        <View className="gap-2 border-t border-slate-800 pt-4">
          <Button
            label="Delete invoice"
            onPress={() => setConfirmingDelete(true)}
            variant="danger"
            testID="delete-invoice"
          />
          <Text className="text-center text-xs leading-relaxed text-slate-500">
            Clears the invoice back-links on the time entries and trackers it claimed.
          </Text>
        </View>

        {confirmingDelete ? (
          <ConfirmSheet
            open
            title="Delete invoice"
            message={invoiceDeletionMessage(invoice)}
            detail={invoiceDeletionDetail(invoice)}
            onConfirm={handleDelete}
            onClose={() => setConfirmingDelete(false)}
            errorFallback="Could not delete the invoice. Try again."
          />
        ) : null}
      </>
    );
  };

  // Only while there is something to save. `disabled` here is the in-flight
  // double-submit guard, never a lock on a value.
  const footer =
    dirty && invoice && draft ? (
      <View className="gap-2 border-t border-slate-800 px-4 py-3">
        {saveError ? <ErrorNote message={saveError} /> : null}
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Button
              label="Discard"
              onPress={handleDiscard}
              variant="secondary"
              disabled={saving}
            />
          </View>
          <View className="flex-1">
            <Button
              label="Save changes"
              onPress={handleSave}
              loading={saving}
              testID="save-invoice"
            />
          </View>
        </View>
      </View>
    ) : undefined;

  return (
    <>
      {/* Renders nothing; it only sets this route's options. See above. */}
      <Stack.Screen options={SCREEN_OPTIONS} />

      <Screen
        footer={footer}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        keyboardAvoiding
        // The header is the stack's, so this screen's own top inset is already
        // accounted for; only the bottom edge is left to it.
        edges={['bottom']}
      >
        {body()}
      </Screen>
    </>
  );
}
