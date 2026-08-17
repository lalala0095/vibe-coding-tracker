// Create or edit one client. The same form does both.
//
// ── No locking (CLAUDE.md) ───────────────────────────────────────────────────
//
// Nothing here is read-only. A negative default rate is surprising, not
// forbidden, so it gets an amber `warning` and saves exactly as typed. The save
// button's `loading` state is a double-submit guard and the only inert thing on
// screen.
//
// ── Clearing conventions ─────────────────────────────────────────────────────
//
// The form emits plain values and `null` uniformly means "cleared". Which of
// the two wire conventions carries that null is the screen's business, not the
// form's — see the block comment in `app/clients.tsx`. `currency` is the one
// field where `null` does NOT mean cleared: it is non-nullable server-side, so
// null here means "leave whatever is stored alone".

import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import { apiErrorMessage } from '@/api';
import {
  Button,
  ErrorNote,
  NumberField,
  Screen,
  TextField,
} from '@/components';
import type { Client } from '@/types';
import {
  describeClientRate,
  parseRateInput,
  rateInputError,
  rateInputWarning,
  rateToInput,
} from './rates';

/** Plain values. `null` means "cleared", except on `currency` — see the header. */
export interface ClientFormValues {
  name: string;
  /** `null` clears the default rate. `0` is a real rate of zero. */
  default_rate: number | null;
  /** `null` means "leave the stored currency alone". Never the string "null". */
  currency: string | null;
  billing_email: string | null;
  billing_address: string | null;
}

export interface ClientFormProps {
  /** The client being edited, or `null` to create one. */
  client: Client | null;
  /** Throwing surfaces the message in the form and keeps it open. */
  onSubmit: (values: ClientFormValues) => Promise<void>;
  onCancel: () => void;
}

interface FieldErrors {
  name?: string;
  rate?: string;
}

export default function ClientForm({ client, onSubmit, onCancel }: ClientFormProps) {
  const [name, setName] = useState(client?.name ?? '');
  // Held as text so "" (inherit) and "0" (bill nothing) stay distinguishable —
  // see the header of `rates.ts`.
  const [rate, setRate] = useState(rateToInput(client?.default_rate ?? null));
  const [currency, setCurrency] = useState(client?.currency ?? 'USD');
  const [email, setEmail] = useState(client?.billing_email ?? '');
  const [address, setAddress] = useState(client?.billing_address ?? '');

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmedCurrency = currency.trim();
  // The currency shown alongside the rate while typing. A blanked box keeps
  // formatting against what is still stored rather than falling back to USD and
  // implying a change that will not be sent.
  const previewCurrency = trimmedCurrency || client?.currency || 'USD';

  // Renaming is not a rewrite: `client_name` is denormalised onto projects,
  // tasks and time entries, and invoices snapshot theirs permanently. One calm
  // line, and only at the moment it becomes true.
  const renaming = client !== null && name.trim() !== '' && name.trim() !== client.name;

  const handleSubmit = async () => {
    const next: FieldErrors = {};

    const trimmedName = name.trim();
    if (!trimmedName) next.name = 'A client needs a name.';

    const rateError = rateInputError(rate, 'Default rate');
    if (rateError) next.rate = rateError;

    setErrors(next);
    if (Object.keys(next).length > 0 || !trimmedName) return;

    setSubmitError('');
    setSubmitting(true);
    try {
      await onSubmit({
        name: trimmedName,
        // "" → null clears the rate; "0" → 0 survives as a real zero.
        default_rate: parseRateInput(rate),
        // A blanked currency is never sent. It is non-nullable server-side, and
        // the "null" sentinel would be stored verbatim and then printed on a
        // client-facing invoice.
        currency: trimmedCurrency || null,
        billing_email: email.trim() || null,
        billing_address: address.trim() || null,
      });
    } catch (e: unknown) {
      setSubmitError(apiErrorMessage(e, 'Could not save this client.'));
      setSubmitting(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      {/*
        `Screen` already owns the page background, the safe area, the scroll
        body and the pinned header/footer slots, so the modal reuses it rather
        than growing a second layout of its own.
      */}
      <Screen
        keyboardAvoiding
        header={
          <View className="flex-row items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <Text className="text-base font-semibold text-slate-100">
              {client ? 'Edit client' : 'New client'}
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
              <Text className="text-sm font-medium text-slate-400">Cancel</Text>
            </Pressable>
          </View>
        }
        footer={
          <View className="border-t border-slate-800 px-4 py-3">
            <Button
              label={client ? 'Save client' : 'Create client'}
              onPress={handleSubmit}
              loading={submitting}
              testID="save-client"
            />
          </View>
        }
      >
        <TextField
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="Acme Pte Ltd"
          autoCapitalize="words"
          error={errors.name}
          hint={
            renaming
              ? 'Renaming updates this client only. Projects, tasks and past invoices keep the name they were saved with.'
              : undefined
          }
          testID="client-name"
        />

        <NumberField
          label="Default hourly rate"
          value={rate}
          onChangeText={setRate}
          placeholder="Leave empty to inherit"
          suffix={previewCurrency}
          error={errors.rate}
          warning={rateInputWarning(rate)}
          hint={describeClientRate(rate, previewCurrency)}
          testID="client-rate"
        />

        {/*
          The explicit way back to "no rate". Without it the only route from 0
          to empty is a backspace on a keypad, and the two values are exactly
          the pair this screen must keep separable.
        */}
        {rate.trim() !== '' ? (
          <Pressable
            onPress={() => setRate('')}
            hitSlop={8}
            accessibilityRole="button"
            className="-mt-2 self-start"
          >
            <Text className="text-xs font-medium text-violet-400">
              Clear rate — inherit instead
            </Text>
          </Pressable>
        ) : null}

        <TextField
          label="Currency"
          value={currency}
          onChangeText={setCurrency}
          placeholder="USD"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={8}
          hint={
            trimmedCurrency
              ? 'A currency code — used to format every amount for this client.'
              : 'Blank leaves the stored currency unchanged; it is never cleared.'
          }
          testID="client-currency"
        />

        <TextField
          label="Billing email"
          value={email}
          onChangeText={setEmail}
          placeholder="accounts@acme.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          testID="client-email"
        />

        <TextField
          label="Billing address"
          value={address}
          onChangeText={setAddress}
          placeholder="The address that prints in an invoice's Bill To."
          multiline
          numberOfLines={4}
          testID="client-address"
        />

        {submitError ? <ErrorNote message={submitError} /> : null}
      </Screen>
    </Modal>
  );
}
