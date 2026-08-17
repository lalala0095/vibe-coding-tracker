// Record or amend one payment against an invoice.
//
// A payment carries two amounts, not one: `amount_paid` in the currency the
// invoice was raised in, and `amount_received` in whatever currency actually
// landed. The gap between them — FX spread, wire fees, an underpayment — is the
// thing this form exists to capture, and the implied rate under the fields is
// what the owner is really checking as they type.
//
// ── Nothing here is ever locked ──────────────────────────────────────────────
//
// No value on this form is read-only at any invoice status (CLAUDE.md, § no
// locking). An overpayment, a blank currency, a negative amount, a date in the
// future: each draws a note and is still saved exactly as typed. The
// double-submit guard is the `if (busy) return` check inside the handler; the
// button's spinner follows it rather than standing in for it.
//
// ── What is computed here, and what is not ───────────────────────────────────
//
// `computePayments` — the verbatim twin of the server's arithmetic — drives the
// live preview only: the rate this payment implies and the outstanding it would
// leave. The server recomputes all of it on write and hands back the whole
// invoice, and from that moment the server's numbers are the ones on screen.

import { useState } from 'react';
import { Text, View } from 'react-native';

import { addInvoicePayment, apiErrorMessage, updateInvoicePayment } from '@/api';
import { Button, DateTimeField, NumberField, TextField } from '@/components';
import { computePayments, formatMoney } from '@/lib/money';
import { todaySgt } from '@/lib/sgt';
// `dayOf` lives beside the create sheet because that is where it was first
// needed. It is one composition of `parseSgt` + `sgtDay`, and importing it
// beats writing a second copy that could drift on how a `DateTimeField` value
// becomes a bare day.
import { dayOf } from '@/screens/invoices/create/dates';
// The one definition of the "null" clearing sentinel, for the same reason.
import { clearable } from '@/screens/invoices/create/payload';
import Sheet from '@/screens/now/Sheet';
import type {
  CreatePaymentPayload,
  Invoice,
  InvoicePayment,
  UpdatePaymentPayload,
} from '@/types';

import PaymentWarning from './PaymentWarning';
import { formatRate } from './rate';

export interface PaymentFormProps {
  open: boolean;
  invoice: Invoice;
  /** The payment being amended. Null records a new one. */
  payment: InvoicePayment | null;
  /**
   * `settings.payout_currency` — "" when unset, or when the settings call
   * failed. Best-effort by design: the form falls back to the invoice's own
   * currency rather than refusing to open.
   */
  payoutCurrency: string;
  /** The server's recomputed invoice, straight from the write. */
  onSaved: (invoice: Invoice) => void;
  onClose: () => void;
}

/** A half-typed "1." or an emptied field reads as 0 rather than NaN. */
function parseAmount(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function PaymentForm({
  open,
  invoice,
  payment,
  payoutCurrency,
  onSaved,
  onClose,
}: PaymentFormProps) {
  // Every OTHER payment on the invoice. On an edit this excludes the one being
  // changed, so "what is left" means what is left besides this payment — which
  // is both the sensible default amount and the right basis for the overpayment
  // note while it is being retyped.
  const others = (invoice.payments ?? []).filter(
    (other) => other.payment_id !== payment?.payment_id,
  );
  const otherAmounts = others.map((other) => ({
    amount_paid: other.amount_paid,
    amount_received: other.amount_received,
    received_currency: other.received_currency,
  }));
  const remaining = computePayments(otherAmounts, invoice.total).outstanding;

  // `paid_on` is a bare `YYYY-MM-DD`. It starts from `todaySgt()`, never from
  // `.toISOString().slice(0, 10)` — that is the UTC day, and a payment logged
  // on a Singapore evening would be dated yesterday.
  const [paidOn, setPaidOn] = useState<string | null>(() => payment?.paid_on || todaySgt());
  // Amounts are held as raw text: a momentarily empty or half-typed figure must
  // not snap back to 0 under the cursor.
  const [paidText, setPaidText] = useState(() =>
    payment ? String(payment.amount_paid) : remaining > 0 ? String(remaining) : '',
  );
  const [receivedText, setReceivedText] = useState(() =>
    payment ? String(payment.amount_received) : '',
  );
  // ── Why this can never be the string "null" ────────────────────────────────
  // Optional string fields elsewhere in this API are cleared with the literal
  // "null" sentinel. `received_currency` is not one of them: the server rejects
  // the sentinel here, and were it ever stored it would sit on a payment record
  // as four characters pretending to be a currency. So the field defaults to a
  // real currency — the payout currency from settings, or the invoice's own —
  // and when the user empties it the key is OMITTED from the payload rather
  // than sent as a sentinel or as "". Omitting lets the server apply its own
  // payout-then-invoice fallback on create, and leaves the stored currency
  // alone on update.
  const [receivedCurrency, setReceivedCurrency] = useState(
    () => payment?.received_currency || payoutCurrency.trim() || invoice.currency,
  );
  const [notes, setNotes] = useState(() => payment?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const amountPaid = parseAmount(paidText);
  const amountReceived = parseAmount(receivedText);

  // Upper-cased to match the server, which normalises `received_currency` on
  // write: received totals are grouped by exact string, so a typed "php" beside
  // an uppercased settings default would split one currency into two rows and
  // blank out the effective rate. The INPUT is left exactly as typed — this
  // derives a value, it does not rewrite the field under the cursor.
  const currency = receivedCurrency.trim().toUpperCase();

  const draft = {
    amount_paid: amountPaid,
    amount_received: amountReceived,
    received_currency: currency,
  };

  // The rate this payment alone implies. Null when nothing was paid — there is
  // no rate against zero, and it is not 0.
  const impliedRate = computePayments([draft], invoice.total).payments[0].rate;

  // What the invoice would be left owing with this payment applied alongside
  // the others. Unclamped, like the server's.
  const outstandingAfter = computePayments([...otherAmounts, draft], invoice.total).outstanding;

  const sameCurrency = currency === invoice.currency;
  const overpaying = outstandingAfter < 0;
  const nothingReceived = amountPaid !== 0 && amountReceived === 0;
  const noCurrency = currency === '' && amountReceived !== 0;
  const negative = amountPaid < 0 || amountReceived < 0;
  const paidDay = dayOf(paidOn);

  async function handleSubmit() {
    // The double-submit guard. Deliberately a check, not a lock on any value.
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const base = {
        paid_on: paidDay,
        amount_paid: amountPaid,
        amount_received: amountReceived,
        // Omitted when blank — never "" and never the "null" sentinel. See the
        // note on the state above.
        ...(currency ? { received_currency: currency } : {}),
      };

      const saved = payment
        ? await updateInvoicePayment(invoice.id, payment.payment_id, {
            ...base,
            // Cleared by the house sentinel: a real JSON null reads as "field
            // absent" and would leave the old note in place.
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
    } catch (e) {
      setError(
        apiErrorMessage(e, 'Could not save the payment. What you entered is still here — try again.'),
      );
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      title={payment ? 'Edit payment' : 'Record payment'}
      onClose={onClose}
      footer={
        <>
          {error ? <Text className="text-xs text-red-400">{error}</Text> : null}
          <Text className="text-xs text-slate-500">
            {invoice.invoice_number} · {formatMoney(invoice.total, invoice.currency)}
          </Text>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button label="Cancel" variant="secondary" onPress={onClose} />
            </View>
            <View className="flex-1">
              <Button
                label={payment ? 'Save payment' : 'Record payment'}
                loading={busy}
                onPress={handleSubmit}
              />
            </View>
          </View>
        </>
      }
    >
      <DateTimeField
        label="Date paid"
        mode="date"
        value={paidOn}
        onChange={setPaidOn}
        warning={
          paidDay ? undefined : 'No date set. The server may refuse to save without one.'
        }
      />

      <NumberField
        label={`Amount paid (${invoice.currency})`}
        value={paidText}
        onChangeText={setPaidText}
        hint={
          remaining > 0
            ? `${formatMoney(remaining, invoice.currency)} outstanding${
                payment ? ' besides this payment' : ''
              }`
            : payment
              ? 'Nothing outstanding besides this payment'
              : 'Nothing outstanding'
        }
      />

      <NumberField
        label="Amount received"
        value={receivedText}
        onChangeText={setReceivedText}
        hint="What actually landed, in the currency it landed as."
      />

      <TextField
        label="Received currency"
        value={receivedCurrency}
        onChangeText={setReceivedCurrency}
        placeholder={invoice.currency}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={8}
        hint={
          payoutCurrency.trim()
            ? `Default payout currency: ${payoutCurrency.trim()}`
            : 'No payout currency set — defaulting to the invoice currency.'
        }
      />

      {/* ── Live figures ── */}
      {/* Computed by the twin of the server's arithmetic while the fields are
          being typed. Replaced by the server's own numbers on save. */}
      <View className="gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5">
        <View className="flex-row items-baseline justify-between">
          <Text className="text-sm text-slate-400">Implied rate</Text>
          <Text className="text-sm tabular-nums text-slate-200">
            {impliedRate === null
              ? '—'
              : sameCurrency
                ? formatRate(impliedRate)
                : `1 ${invoice.currency} = ${formatRate(impliedRate)} ${currency || '?'}`}
          </Text>
        </View>
        <View className="flex-row items-baseline justify-between">
          <Text className="text-sm text-slate-400">Outstanding after this</Text>
          <Text
            className={`text-sm tabular-nums ${
              outstandingAfter < 0
                ? 'text-amber-300'
                : outstandingAfter === 0
                  ? 'text-green-400'
                  : 'text-slate-200'
            }`}
          >
            {formatMoney(outstandingAfter, invoice.currency)}
          </Text>
        </View>
      </View>

      <TextField
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        multiline
        numberOfLines={2}
        placeholder="Wire fee, sender's reference, anything worth remembering"
      />

      {/* ── Notes on odd figures ── */}
      {/* Every one of these warns and keeps the value. None stops a save, and
          none touches what was typed. */}
      {negative ? (
        <PaymentWarning tone="red" title="A negative amount is recorded as entered.">
          Negative figures are stored exactly as typed and will pull the totals down. If you meant
          a refund, that reads correctly; if not, check the sign.
        </PaymentWarning>
      ) : null}

      {overpaying ? (
        <PaymentWarning
          title={`This leaves the invoice ${formatMoney(
            -outstandingAfter,
            invoice.currency,
          )} overpaid.`}
        >
          The invoice totals {formatMoney(invoice.total, invoice.currency)}. The amount is kept
          exactly as entered — nothing is capped to make it fit.
        </PaymentWarning>
      ) : null}

      {nothingReceived ? (
        <PaymentWarning title="Money paid, nothing recorded as received.">
          Right for a transfer still in flight — it saves fine. Come back and enter what landed
          once it clears, so the FX gap is captured.
        </PaymentWarning>
      ) : null}

      {noCurrency ? (
        <PaymentWarning title="No currency for what was received.">
          The amount is saved either way, but without a currency the received total cannot be
          reported under one and the rate reads against nothing.
        </PaymentWarning>
      ) : null}
    </Sheet>
  );
}
