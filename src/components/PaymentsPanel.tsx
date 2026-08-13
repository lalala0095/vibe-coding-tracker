// What the client paid, and what actually landed.
//
// The invoice is raised in one currency and the money arrives in another, minus
// FX spread and wire fees, possibly across several instalments. This panel is
// the only place that gap is visible.
//
// Two rules shape everything below:
//
//   1. It is internal. Payments are NEVER printed — InvoicePrintView renders the
//      document the client receives, and what reached the owner's bank after FX
//      is nobody's business but theirs. Nothing here is shared with that view.
//   2. It never locks. An overpayment, money paid with nothing received, a
//      blank currency: each is warned about and kept exactly as entered (§1 and
//      §5 rule 4 — the same posture InvoiceLineTable takes on an over-discount).
//
// The figures shown here are the SERVER's. It recomputes amount_paid,
// outstanding and the effective rate on every payment write and hands the whole
// invoice back, so this panel only ever displays. `computePayments` is used for
// live arithmetic while the form is being typed (see PaymentForm), never to
// second-guess a stored value.

import { useState, type ReactNode } from 'react';
import type { Invoice, InvoicePayment } from '../types';
import { deleteInvoicePayment } from '../api';
import { formatMoney } from '../lib/money';
import ConfirmDialog from './ConfirmDialog';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-SG', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * A rate to 6 dp, trailing zeros trimmed. Null is "—", not "0": there is no
 * rate against a zero payment, and printing 0 would read as a real exchange
 * rate of zero.
 */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return rate.toLocaleString('en-SG', { maximumFractionDigits: 6 });
}

/** "1 USD = 57.25 PHP", or null when there is nothing to state a rate between. */
export function rateSentence(
  rate: number | null | undefined, from: string, to: string
): string | null {
  if (rate === null || rate === undefined) return null;
  if (!from || !to) return null;
  if (from === to) return null;   // a same-currency "rate" of 1 says nothing
  return `1 ${from} = ${formatRate(rate)} ${to}`;
}

// ── Warning note ──────────────────────────────────────────────────────────────
// Shared with PaymentForm so the panel and the dialog warn in one voice. Amber
// is "unusual, probably deliberate"; red is "almost certainly a mistake". Both
// are notes — neither has ever blocked a value.

export function PaymentWarning({
  tone = 'amber', title, children,
}: {
  tone?: 'amber' | 'red';
  title: ReactNode;
  children?: ReactNode;
}) {
  const shell =
    tone === 'red'
      ? 'border-red-400/30 bg-red-400/10'
      : 'border-amber-400/30 bg-amber-400/10';
  const icon = tone === 'red' ? 'text-red-400' : 'text-amber-400';
  const head = tone === 'red' ? 'text-red-300' : 'text-amber-300';
  const body = tone === 'red' ? 'text-red-400/80' : 'text-amber-300/70';

  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${shell}`}>
      <svg className={`w-4 h-4 shrink-0 mt-0.5 ${icon}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <div className="text-xs leading-relaxed min-w-0">
        <p className={`font-medium ${head}`}>{title}</p>
        {children && <p className={`mt-0.5 ${body}`}>{children}</p>}
      </div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface Props {
  invoice: Invoice;
  /** The server's recomputed invoice, straight from a payment write. */
  onUpdated: (invoice: Invoice) => void;
  /** Open the form to record a new payment. The page owns the dialog. */
  onNew: () => void;
  onEdit: (payment: InvoicePayment) => void;
}

export default function PaymentsPanel({ invoice, onUpdated, onNew, onEdit }: Props) {
  // Held as the payment rather than a flag, so the dialog keeps naming it while
  // the list re-renders underneath — the same reason InvoicesPage holds its
  // delete target as an invoice.
  const [deleteTarget, setDeleteTarget] = useState<InvoicePayment | null>(null);

  // Every derived field is read defensively: an invoice stored before payments
  // existed has none of these keys, and the list endpoint may still be serving
  // it from cache.
  const payments = invoice.payments ?? [];
  const amountPaid = invoice.amount_paid ?? 0;
  const receivedTotals = invoice.received_totals ?? [];
  const outstanding = invoice.outstanding ?? invoice.total;

  const overpaid = outstanding < 0;
  const settled = payments.length > 0 && outstanding === 0;
  // Money left, nothing arrived. Plausible — a payment logged the day it was
  // sent, before it cleared — so this is amber, not red, and never blocks.
  const awaitingFunds = payments.filter((p) => p.amount_paid !== 0 && p.amount_received === 0);

  const handleDelete = async (payment: InvoicePayment) => {
    try {
      onUpdated(await deleteInvoicePayment(invoice.id, payment.payment_id));
    } catch {
      // Thrown, not swallowed: ConfirmDialog keeps itself open and shows this.
      throw new Error('Failed to delete the payment. It is still here — try again.');
    }
  };

  return (
    <div className="border-t border-slate-800 pt-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-slate-500 uppercase tracking-wider">Payments</p>
          {/* Said out loud, because the rest of this pane IS the printed
              document and this section deliberately is not. */}
          <p className="text-xs text-slate-600 mt-0.5">
            Internal — never printed on the invoice.
          </p>
        </div>
        <button
          onClick={onNew}
          className="shrink-0 flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Record payment
        </button>
      </div>

      {payments.length === 0 ? (
        <p className="text-sm text-slate-500 bg-slate-900 border border-slate-800 rounded-lg px-3 py-3">
          Nothing recorded yet — the full{' '}
          <span className="tabular-nums text-slate-300">
            {formatMoney(invoice.total, invoice.currency)}
          </span>{' '}
          is outstanding.
        </p>
      ) : (
        <>
          {/* ── The instalments ── */}
          <div className="flex flex-col gap-2">
            {payments.map((payment) => {
              const sentence = rateSentence(
                payment.rate, payment.currency || invoice.currency, payment.received_currency
              );
              return (
                <div
                  key={payment.payment_id}
                  className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5 flex items-start gap-3"
                >
                  <div className="min-w-0 flex-1 flex flex-col gap-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-xs text-slate-500 tabular-nums shrink-0">
                        {formatDate(payment.paid_on)}
                      </span>
                      <span className="text-sm text-slate-100 tabular-nums font-medium">
                        {formatMoney(payment.amount_paid, payment.currency || invoice.currency)}
                      </span>
                      <span className="text-slate-600 text-xs">→</span>
                      <span className={`text-sm tabular-nums ${
                        payment.amount_received === 0 ? 'text-amber-300' : 'text-slate-300'
                      }`}>
                        {formatMoney(payment.amount_received, payment.received_currency)}
                      </span>
                      {payment.received_currency && (
                        <span className="text-xs text-slate-500">{payment.received_currency}</span>
                      )}
                    </div>
                    {sentence && <p className="text-xs text-slate-500 tabular-nums">{sentence}</p>}
                    {!payment.received_currency && (
                      <p className="text-xs text-amber-300/80">
                        No currency recorded for what arrived.
                      </p>
                    )}
                    {payment.notes && (
                      <p className="text-xs text-slate-400 whitespace-pre-wrap">{payment.notes}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => onEdit(payment)}
                      className="px-2 py-1 text-xs rounded-lg text-slate-400 hover:text-violet-300 hover:bg-slate-800 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleteTarget(payment)}
                      className="p-1 text-slate-600 hover:text-red-400 transition-colors"
                      title="Delete payment"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Summary ── */}
          <div className="flex justify-end">
            <div className="w-full sm:w-80 flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between text-slate-400">
                <span>Invoiced</span>
                <span className="tabular-nums text-slate-200">
                  {formatMoney(invoice.total, invoice.currency)}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Paid</span>
                <span className="tabular-nums text-slate-200">
                  {formatMoney(amountPaid, invoice.currency)}
                </span>
              </div>

              {/* Per currency, never summed across them — pesos plus dollars is
                  a number that means nothing (types.ts::ReceivedTotal). */}
              {receivedTotals.map((received) => (
                <div key={received.currency || '—'} className="flex justify-between text-slate-400">
                  <span>Received{received.currency ? ` (${received.currency})` : ''}</span>
                  <span className="tabular-nums text-slate-200">
                    {formatMoney(received.amount, received.currency)}
                  </span>
                </div>
              ))}

              <div className="flex justify-between pt-2 mt-1 border-t border-slate-700 font-semibold">
                <span className="text-slate-200">Outstanding</span>
                <span className={`tabular-nums ${
                  overpaid ? 'text-amber-300' : settled ? 'text-green-400' : 'text-slate-100'
                }`}>
                  {formatMoney(outstanding, invoice.currency)}
                </span>
              </div>

              <div className="flex justify-between text-slate-500 text-xs">
                <span>Effective rate</span>
                <span className="tabular-nums">
                  {invoice.effective_rate === null || invoice.effective_rate === undefined
                    ? receivedTotals.length > 1
                      ? 'mixed currencies'
                      : '—'
                    : `1 ${invoice.currency} = ${formatRate(invoice.effective_rate)} ${
                        receivedTotals[0]?.currency || ''
                      }`}
                </span>
              </div>
            </div>
          </div>

          {/* Warn, keep the value, never clamp — outstanding is deliberately
              unclamped server-side (§5 rule 4). */}
          {overpaid && (
            <PaymentWarning title={
              `Paid ${formatMoney(-outstanding, invoice.currency)} more than this invoice totals.`
            }>
              Recorded payments come to {formatMoney(amountPaid, invoice.currency)} against a
              total of {formatMoney(invoice.total, invoice.currency)}. The figures are kept
              exactly as entered — nothing is adjusted to make them balance.
            </PaymentWarning>
          )}

          {awaitingFunds.length > 0 && (
            <PaymentWarning title={
              awaitingFunds.length === 1
                ? 'One payment records money paid but nothing received.'
                : `${awaitingFunds.length} payments record money paid but nothing received.`
            }>
              That is right for a transfer still in flight. If it has landed, edit the payment
              and enter what arrived, so the FX gap is captured.
            </PaymentWarning>
          )}
        </>
      )}

      {deleteTarget && (
        <ConfirmDialog
          open
          title="Delete payment"
          message={
            <>
              Delete the payment of{' '}
              <span className="text-slate-100 font-medium tabular-nums">
                {formatMoney(deleteTarget.amount_paid, deleteTarget.currency || invoice.currency)}
              </span>{' '}
              on {formatDate(deleteTarget.paid_on)}?
            </>
          }
          detail="The invoice's paid, received and outstanding figures are recalculated without it. The invoice's status is not changed — a paid invoice stays marked paid."
          onConfirm={() => handleDelete(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
