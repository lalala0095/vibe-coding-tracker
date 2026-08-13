// Record or amend one payment against an invoice.
//
// The dialog is always OFFERED, never required — see the note on the paid-status
// trigger in InvoicesPage. Closing it leaves the invoice exactly as it was.
//
// Nothing here is disabled or read-only, at any invoice status, for any value
// (§1 — no locking). An overpayment, a blank currency, a negative amount: each
// draws a note and is still saved as typed. Even the Save button stays live
// while a request is in flight; the double-submit guard is a check inside the
// handler, not a disabled attribute, so no control on this form can ever be
// grey.
//
// The server recomputes every derived figure and returns the whole invoice, so
// `computePayments` is used ONLY for the live preview under the fields — the
// implied rate and the outstanding this payment would leave. Once saved, the
// server's numbers are the ones on screen.

import { useState } from 'react';
import type {
  Invoice, InvoicePayment, CreatePaymentPayload, UpdatePaymentPayload,
} from '../types';
import { addInvoicePayment, updateInvoicePayment } from '../api';
import { computePayments, formatMoney } from '../lib/money';
import Modal, { ButtonSpinner, MODAL_CANCEL_BUTTON, MODAL_PRIMARY_BUTTON } from './Modal';
import { FIELD, LABEL, clearable } from './InvoiceBuilder';
import { PaymentWarning, formatRate } from './PaymentsPanel';

// ── Helpers ───────────────────────────────────────────────────────────────────

function todaySGT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

/** A half-typed "1." or an emptied field reads as 0 rather than NaN. */
function parseAmount(raw: string): number {
  const parsed = Number(raw);
  return raw.trim() === '' || !Number.isFinite(parsed) ? 0 : parsed;
}

// ── Form ──────────────────────────────────────────────────────────────────────

interface Props {
  invoice: Invoice;
  /** The payment being amended. Null records a new one. */
  payment: InvoicePayment | null;
  /**
   * `settings.payout_currency` — "" when unset, or when the settings load
   * failed. Best-effort by design: the form falls back to the invoice's own
   * currency rather than refusing to open.
   */
  payoutCurrency: string;
  /** The server's recomputed invoice. */
  onSaved: (invoice: Invoice) => void;
  onClose: () => void;
}

export default function PaymentForm({
  invoice, payment, payoutCurrency, onSaved, onClose,
}: Props) {
  // Every other payment on the invoice. On an edit this excludes the one being
  // changed, so "what is left" means what is left BESIDES this payment — which
  // is both the sensible default amount and the right basis for the overpayment
  // note while it is being retyped.
  const others = (invoice.payments ?? []).filter(
    (p) => p.payment_id !== payment?.payment_id
  );
  const remaining = computePayments(
    others.map((p) => ({
      amount_paid: p.amount_paid,
      amount_received: p.amount_received,
      received_currency: p.received_currency,
    })),
    invoice.total
  ).outstanding;

  const [paidOn, setPaidOn] = useState(() => payment?.paid_on || todaySGT());
  // Amounts are held as raw text, the same reason InvoiceLineTable keeps drafts:
  // a momentarily empty or half-typed figure must not snap back to 0 under the
  // cursor.
  const [paidText, setPaidText] = useState(() =>
    payment ? String(payment.amount_paid) : remaining > 0 ? String(remaining) : ''
  );
  const [receivedText, setReceivedText] = useState(() =>
    payment ? String(payment.amount_received) : ''
  );
  const [receivedCurrency, setReceivedCurrency] = useState(
    () => payment?.received_currency || payoutCurrency.trim() || invoice.currency
  );
  const [notes, setNotes] = useState(() => payment?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const amountPaid = parseAmount(paidText);
  const amountReceived = parseAmount(receivedText);
  // Upper-cased to match the server, which normalises `received_currency` on
  // write: the received totals are grouped by exact string, so a typed "php"
  // sitting beside an uppercased settings default would split one currency into
  // two received_totals rows and blank out the effective rate. Normalising here
  // too means the live preview shows what will actually be stored.
  //
  // The INPUT is left exactly as typed — this derives a value, it does not
  // rewrite the field under the cursor. Never route this field through
  // `clearable()`: the server rejects the "null" sentinel here with a 400, and
  // a blank currency is handled by omitting the key (see handleSubmit).
  const currency = receivedCurrency.trim().toUpperCase();

  const draft = {
    amount_paid: amountPaid,
    amount_received: amountReceived,
    received_currency: currency,
  };

  // The rate this payment alone implies — the number the owner is really
  // checking as they type.
  const impliedRate = computePayments([draft], invoice.total).payments[0].rate;

  // What the invoice would be left owing with this payment applied alongside
  // the others. Unclamped, like the server's (§5 rule 4).
  const outstandingAfter = computePayments(
    [
      ...others.map((p) => ({
        amount_paid: p.amount_paid,
        amount_received: p.amount_received,
        received_currency: p.received_currency,
      })),
      draft,
    ],
    invoice.total
  ).outstanding;

  const sameCurrency = currency === invoice.currency;
  const overpaying = outstandingAfter < 0;
  const nothingReceived = amountPaid !== 0 && amountReceived === 0;
  const noCurrency = currency === '' && amountReceived !== 0;
  const negative = amountPaid < 0 || amountReceived < 0;
  const noDate = paidOn.trim() === '';

  const handleSubmit = async () => {
    // The double-submit guard. Deliberately a check, not `disabled` — see the
    // header note.
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const base = {
        paid_on: paidOn,
        amount_paid: amountPaid,
        amount_received: amountReceived,
        // Omitted when blank rather than sent as "": on create that lets the
        // server apply its payout-currency-then-invoice-currency fallback, and
        // on update it leaves the stored currency alone.
        ...(currency ? { received_currency: currency } : {}),
      };
      const saved = payment
        ? await updateInvoicePayment(invoice.id, payment.payment_id, {
            ...base,
            // Cleared by the house sentinel — a real JSON null reads as "field
            // absent" and would leave the old note in place (see the note on
            // CLEAR in InvoiceBuilder).
            notes: clearable(notes),
          } satisfies UpdatePaymentPayload)
        : await addInvoicePayment(invoice.id, {
            ...base,
            // On create an absent note is simply no note — there is no settings
            // default for it to fall back to, so nothing needs clearing.
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          } satisfies CreatePaymentPayload);
      onSaved(saved);
      onClose();
    } catch {
      setError('Failed to save the payment. Your entry is still here — try again.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={payment ? 'Edit payment' : 'Record payment'}
      onClose={onClose}
      size="md"
      footer={
        <>
          <span className="text-xs text-slate-500">
            {invoice.invoice_number} · {formatMoney(invoice.total, invoice.currency)}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={MODAL_CANCEL_BUTTON}>
              Cancel
            </button>
            <button type="button" onClick={handleSubmit} className={MODAL_PRIMARY_BUTTON}>
              {busy && <ButtonSpinner />}
              {payment ? 'Save payment' : 'Record payment'}
            </button>
          </div>
        </>
      }
    >
      {/* ── What the client paid ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL}>Date paid</label>
          <input
            type="date"
            value={paidOn}
            onChange={(e) => setPaidOn(e.target.value)}
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL}>Amount paid ({invoice.currency})</label>
          <input
            type="number"
            step="0.01"
            value={paidText}
            onChange={(e) => setPaidText(e.target.value)}
            placeholder="0.00"
            className={`${FIELD} text-right tabular-nums`}
          />
          <p className="text-xs text-slate-600 mt-1 tabular-nums">
            {remaining > 0
              ? `${formatMoney(remaining, invoice.currency)} outstanding${
                  payment ? ' besides this payment' : ''
                }`
              : payment
                ? 'Nothing outstanding besides this payment'
                : 'Nothing outstanding'}
          </p>
        </div>
      </div>

      {/* ── What actually landed ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL}>Amount received</label>
          <input
            type="number"
            step="0.01"
            value={receivedText}
            onChange={(e) => setReceivedText(e.target.value)}
            placeholder="0.00"
            className={`${FIELD} text-right tabular-nums`}
          />
        </div>
        <div>
          <label className={LABEL}>Received currency</label>
          <input
            type="text"
            value={receivedCurrency}
            onChange={(e) => setReceivedCurrency(e.target.value)}
            placeholder={invoice.currency}
            className={FIELD}
          />
          <p className="text-xs text-slate-600 mt-1">
            {payoutCurrency.trim()
              ? `Default payout currency: ${payoutCurrency.trim()}`
              : 'No payout currency set — defaulting to the invoice currency.'}
          </p>
        </div>
      </div>

      {/* ── Live figures ── */}
      {/* Computed by the twin of the server's arithmetic while the fields are
          being typed. Replaced by the server's own numbers on save. */}
      <div className="bg-slate-800/50 border border-slate-800 rounded-lg px-3 py-2.5 flex flex-col gap-1.5 text-sm">
        <div className="flex justify-between text-slate-400">
          <span>Implied rate</span>
          <span className="tabular-nums text-slate-200">
            {impliedRate === null
              ? '—'
              : sameCurrency
                ? formatRate(impliedRate)
                : `1 ${invoice.currency} = ${formatRate(impliedRate)} ${currency || '?'}`}
          </span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Outstanding after this</span>
          <span className={`tabular-nums ${
            outstandingAfter < 0 ? 'text-amber-300'
              : outstandingAfter === 0 ? 'text-green-400' : 'text-slate-200'
          }`}>
            {formatMoney(outstandingAfter, invoice.currency)}
          </span>
        </div>
      </div>

      <div>
        <label className={LABEL}>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Wire fee, sender's reference, anything worth remembering"
          className={`${FIELD} resize-y`}
        />
      </div>

      {/* ── Notes on odd figures ── */}
      {/* Every one of these warns and keeps the value. None of them stops a
          save, and none of them touches what was typed (§1, §5 rule 4). */}
      {negative && (
        <PaymentWarning tone="red" title="A negative amount is recorded as entered.">
          Negative figures are stored exactly as typed and will pull the totals down. If you
          meant a refund, that reads correctly; if not, check the sign.
        </PaymentWarning>
      )}

      {overpaying && (
        <PaymentWarning title={
          `This leaves the invoice ${formatMoney(-outstandingAfter, invoice.currency)} overpaid.`
        }>
          The invoice totals {formatMoney(invoice.total, invoice.currency)}. The amount is kept
          exactly as entered — nothing is capped to make it fit.
        </PaymentWarning>
      )}

      {nothingReceived && (
        <PaymentWarning title="Money paid, nothing recorded as received.">
          Right for a transfer still in flight — it saves fine. Come back and enter what landed
          once it clears, so the FX gap is captured.
        </PaymentWarning>
      )}

      {noCurrency && (
        <PaymentWarning title="No currency for what was received.">
          The amount is saved either way, but without a currency the received total cannot be
          reported under one and the rate reads against nothing.
        </PaymentWarning>
      )}

      {noDate && (
        <PaymentWarning title="No date set.">
          Pick the date the money was paid. Saving without one may be rejected by the server.
        </PaymentWarning>
      )}

      {error && (
        <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
    </Modal>
  );
}
