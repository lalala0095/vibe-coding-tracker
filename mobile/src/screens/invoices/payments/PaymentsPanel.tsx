// What the client paid, and what actually landed.
//
// The invoice is raised in one currency and the money arrives in another, minus
// FX spread and wire fees, possibly across several instalments. This panel is
// the only place that gap is visible.
//
// Two rules shape everything below, both ported from
// `front/src/components/PaymentsPanel.tsx`:
//
//   1. It is internal. Payments are never part of the document the client
//      receives — what reached the owner's bank after FX is nobody's business
//      but theirs. The panel says so out loud.
//   2. It never locks. An overpayment, money paid with nothing received, a
//      blank currency: each is warned about and kept exactly as entered.
//
// ── Every figure here is the server's ────────────────────────────────────────
//
// `amount_paid`, `received_totals`, `outstanding` and `effective_rate` are
// recomputed server-side on every payment write, and all three payment calls
// return the WHOLE invoice. So each one is handed straight to `onInvoiceChange`
// — a payment is never spliced into local state, which would leave the derived
// figures describing the invoice as it was a moment ago. `src/lib/money.ts` is
// used for live arithmetic while the form is being typed (see `PaymentForm`),
// never to second-guess a stored value.

import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { deleteInvoicePayment, getInvoiceSettings } from '@/api';
import { ConfirmSheet } from '@/components';
import { formatMoney } from '@/lib/money';
import { periodLabel } from '@/screens/invoices/invoiceMeta';
import type { Invoice, InvoicePayment } from '@/types';

import PaymentForm from './PaymentForm';
import PaymentWarning from './PaymentWarning';
import { formatRate, rateSentence } from './rate';

export interface PaymentsPanelProps {
  invoice: Invoice;
  /** The server's recomputed invoice, straight from a payment write. */
  onInvoiceChange: (next: Invoice) => void;
}

/** A bare `YYYY-MM-DD` as `1 Aug 2026`. String work only — no Date, no timezone. */
function day(value: string | null): string {
  return periodLabel(value, null);
}

export default function PaymentsPanel({ invoice, onInvoiceChange }: PaymentsPanelProps) {
  // Held as the payment rather than as a flag, so the sheet keeps naming its
  // target while the list re-renders underneath.
  const [editing, setEditing] = useState<InvoicePayment | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InvoicePayment | null>(null);

  // Best effort, and only for the form's default. A failure costs the pre-fill,
  // never the ability to record a payment: the form then falls back to the
  // invoice's own currency, exactly as it does when the setting is unset.
  const [payoutCurrency, setPayoutCurrency] = useState('');
  useEffect(() => {
    let live = true;
    getInvoiceSettings()
      .then((settings) => {
        if (live) setPayoutCurrency(settings.payout_currency ?? '');
      })
      .catch(() => {
        if (live) setPayoutCurrency('');
      });
    return () => {
      live = false;
    };
  }, []);

  // Read defensively: an invoice stored before payments existed has none of
  // these keys, and the list endpoint may still be serving it from cache.
  const payments = invoice.payments ?? [];
  const amountPaid = invoice.amount_paid ?? 0;
  const receivedTotals = invoice.received_totals ?? [];
  // Falls back to the full total, which is what is outstanding when nothing has
  // been paid. Never clamped, in either direction.
  const outstanding = invoice.outstanding ?? invoice.total;

  const overpaid = outstanding < 0;
  const settled = payments.length > 0 && outstanding === 0;
  // Money left, nothing arrived. Plausible — a payment logged the day it was
  // sent, before it cleared — so this is amber, not red, and never blocks.
  const awaitingFunds = payments.filter(
    (payment) => payment.amount_paid !== 0 && payment.amount_received === 0,
  );

  const handleDelete = async (payment: InvoicePayment) => {
    // Not caught: ConfirmSheet keeps itself open on a throw and shows the
    // message, so a failed delete cannot look like a successful one.
    onInvoiceChange(await deleteInvoicePayment(invoice.id, payment.payment_id));
  };

  return (
    <View className="gap-3 border-t border-slate-800 pt-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Payments
          </Text>
          {/* Said out loud, because the rest of an invoice IS the document the
              client receives and this section deliberately is not. */}
          <Text className="text-xs text-slate-500">Internal — never shown to the client.</Text>
        </View>
        <Pressable
          onPress={() => setAdding(true)}
          accessibilityRole="button"
          hitSlop={8}
          className="shrink-0"
        >
          <Text className="text-xs font-medium text-violet-400">+ Record payment</Text>
        </Pressable>
      </View>

      {payments.length === 0 ? (
        <Text className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-sm text-slate-400">
          Nothing recorded yet — the full{' '}
          <Text className="tabular-nums text-slate-300">
            {formatMoney(invoice.total, invoice.currency)}
          </Text>{' '}
          is outstanding.
        </Text>
      ) : (
        <>
          {/* ── The instalments ── */}
          <View className="gap-2">
            {payments.map((payment) => {
              const sentence = rateSentence(
                payment.rate,
                payment.currency || invoice.currency,
                payment.received_currency,
              );
              return (
                <View
                  key={payment.payment_id}
                  className="flex-row items-start gap-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5"
                >
                  <View className="min-w-0 flex-1 gap-1">
                    <View className="flex-row flex-wrap items-baseline gap-x-2">
                      <Text className="text-xs tabular-nums text-slate-500">
                        {day(payment.paid_on)}
                      </Text>
                      <Text className="text-sm font-medium tabular-nums text-slate-100">
                        {formatMoney(payment.amount_paid, payment.currency || invoice.currency)}
                      </Text>
                      <Text className="text-xs text-slate-600">→</Text>
                      <Text
                        className={`text-sm tabular-nums ${
                          payment.amount_received === 0 ? 'text-amber-300' : 'text-slate-300'
                        }`}
                      >
                        {formatMoney(payment.amount_received, payment.received_currency)}
                      </Text>
                      {payment.received_currency ? (
                        <Text className="text-xs text-slate-500">
                          {payment.received_currency}
                        </Text>
                      ) : null}
                    </View>

                    {sentence ? (
                      <Text className="text-xs tabular-nums text-slate-500">{sentence}</Text>
                    ) : null}

                    {!payment.received_currency ? (
                      <Text className="text-xs text-amber-300/80">
                        No currency recorded for what arrived.
                      </Text>
                    ) : null}

                    {payment.notes ? (
                      <Text className="text-xs text-slate-400">{payment.notes}</Text>
                    ) : null}
                  </View>

                  <View className="shrink-0 flex-row items-center gap-3">
                    <Pressable
                      onPress={() => setEditing(payment)}
                      accessibilityRole="button"
                      hitSlop={8}
                    >
                      <Text className="text-xs text-slate-400">Edit</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setDeleteTarget(payment)}
                      accessibilityRole="button"
                      hitSlop={8}
                    >
                      <Text className="text-xs text-slate-600">✕</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>

          {/* ── Summary ── */}
          <View className="gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5">
            <SummaryRow label="Invoiced" value={formatMoney(invoice.total, invoice.currency)} />
            <SummaryRow label="Paid" value={formatMoney(amountPaid, invoice.currency)} />

            {/* Per currency, never summed across them — pesos plus dollars is a
                number that means nothing (types.ts::ReceivedTotal). */}
            {receivedTotals.map((received) => (
              <SummaryRow
                key={received.currency || '—'}
                label={`Received${received.currency ? ` (${received.currency})` : ''}`}
                value={formatMoney(received.amount, received.currency)}
              />
            ))}

            <View className="mt-1 flex-row items-baseline justify-between border-t border-slate-800 pt-2">
              <Text className="text-sm font-semibold text-slate-200">Outstanding</Text>
              {/* Shown exactly as the server computed it. An overpayment reads
                  negative and an unpaid invoice reads its full total; neither is
                  clamped, hidden or reworded into something tidier. */}
              <Text
                className={`text-sm font-semibold tabular-nums ${
                  overpaid ? 'text-amber-300' : settled ? 'text-green-400' : 'text-slate-100'
                }`}
              >
                {formatMoney(outstanding, invoice.currency)}
              </Text>
            </View>

            <View className="flex-row items-baseline justify-between">
              <Text className="text-xs text-slate-500">Effective rate</Text>
              <Text className="text-xs tabular-nums text-slate-500">
                {invoice.effective_rate === null || invoice.effective_rate === undefined
                  ? receivedTotals.length > 1
                    ? 'mixed currencies — no single rate'
                    : '—'
                  : `1 ${invoice.currency} = ${formatRate(invoice.effective_rate)} ${
                      receivedTotals[0]?.currency ?? ''
                    }`}
              </Text>
            </View>
          </View>

          {/* Warn, keep the value, never clamp. */}
          {overpaid ? (
            <PaymentWarning
              title={`Paid ${formatMoney(
                -outstanding,
                invoice.currency,
              )} more than this invoice totals.`}
            >
              Recorded payments come to {formatMoney(amountPaid, invoice.currency)} against a total
              of {formatMoney(invoice.total, invoice.currency)}. The figures are kept exactly as
              entered — nothing is adjusted to make them balance.
            </PaymentWarning>
          ) : null}

          {awaitingFunds.length > 0 ? (
            <PaymentWarning
              title={
                awaitingFunds.length === 1
                  ? 'One payment records money paid but nothing received.'
                  : `${awaitingFunds.length} payments record money paid but nothing received.`
              }
            >
              That is right for a transfer still in flight. If it has landed, edit the payment and
              enter what arrived, so the FX gap is captured.
            </PaymentWarning>
          ) : null}
        </>
      )}

      {/* Mounted only while open, and keyed by target, so each opening starts
          from the payment it is actually editing. */}
      {adding || editing ? (
        <PaymentForm
          key={editing?.payment_id ?? 'new'}
          open
          invoice={invoice}
          payment={editing}
          payoutCurrency={payoutCurrency}
          onSaved={onInvoiceChange}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : null}

      <ConfirmSheet
        open={deleteTarget !== null}
        title="Delete payment"
        message={
          deleteTarget
            ? `Delete the payment of ${formatMoney(
                deleteTarget.amount_paid,
                deleteTarget.currency || invoice.currency,
              )} on ${day(deleteTarget.paid_on)}?`
            : ''
        }
        detail="The paid, received and outstanding figures are recalculated without it. The invoice's status is not changed — a paid invoice stays marked paid."
        onConfirm={() => (deleteTarget ? handleDelete(deleteTarget) : undefined)}
        onClose={() => setDeleteTarget(null)}
        errorFallback="Could not delete the payment. It is still here — try again."
      />
    </View>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-baseline justify-between">
      <Text className="text-sm text-slate-400">{label}</Text>
      <Text className="text-sm tabular-nums text-slate-200">{value}</Text>
    </View>
  );
}
