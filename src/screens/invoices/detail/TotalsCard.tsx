// The totals block.
//
// Two states, and the difference matters:
//
//   saved    the figures the server computed and stored. Printed verbatim.
//   preview  what the draft on screen would total if saved, from the verbatim
//            copy of the web's `computeMoney`. Labelled as unsaved, in amber,
//            so it is never mistaken for the record.
//
// The card itself computes nothing either way — it is handed numbers and lays
// them out.

import { Text, View } from 'react-native';

import { formatHours } from '@/lib/money';
import { money } from '@/screens/invoices/invoiceMeta';

export interface TotalsCardProps {
  currency: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  totalHours: number;
  /** "Discount (10%)" / "Discount" — the percentage comes from the caller. */
  discountLabel: string;
  /** "GST 9%" / "Tax" — the invoice's own snapshot label. */
  taxLabel: string;
  /** True when these are the unsaved preview rather than the stored figures. */
  preview: boolean;
  /** Discount exceeds the subtotal. Warned about, never clamped. */
  overDiscounted: boolean;
}

function Row({
  label,
  value,
  strong = false,
  muted = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <View className="flex-row items-baseline justify-between gap-3">
      <Text
        className={`min-w-0 flex-1 ${strong ? 'text-sm font-semibold text-slate-100' : 'text-xs text-slate-400'}`}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text
        className={`tabular-nums ${
          strong
            ? 'text-lg font-bold text-slate-100'
            : muted
              ? 'text-sm text-slate-500'
              : 'text-sm text-slate-200'
        }`}
      >
        {value}
      </Text>
    </View>
  );
}

export default function TotalsCard({
  currency,
  subtotal,
  discountAmount,
  taxAmount,
  total,
  totalHours,
  discountLabel,
  taxLabel,
  preview,
  overDiscounted,
}: TotalsCardProps) {
  return (
    <View
      className={`rounded-xl border p-4 ${
        preview ? 'border-amber-500/40 bg-slate-900' : 'border-slate-800 bg-slate-900'
      }`}
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">Totals</Text>
        {preview ? (
          <Text className="text-[11px] font-medium text-amber-400">Unsaved preview</Text>
        ) : null}
      </View>

      <View className="mt-3 gap-2">
        <Row label="Billed hours" value={formatHours(totalHours)} muted />
        <Row label="Subtotal" value={money(subtotal, currency)} />
        {discountAmount !== 0 ? (
          <Row label={discountLabel} value={`− ${money(discountAmount, currency)}`} />
        ) : null}
        {taxAmount !== 0 ? <Row label={taxLabel} value={money(taxAmount, currency)} /> : null}
      </View>

      <View className="mt-3 border-t border-slate-800 pt-3">
        <Row label="Total" value={money(total, currency)} strong />
      </View>

      {/*
        CLAUDE.md money rule 4: a discount larger than the subtotal is
        deliberately NOT clamped and yields a negative total. The server stores
        and prints it as computed. This warns; it does not block the save and it
        does not rewrite the figure.
      */}
      {overDiscounted ? (
        <View className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2">
          <Text className="text-xs leading-relaxed text-amber-300">
            The discount is larger than the subtotal, so this invoice totals a negative amount.
            That is stored and printed exactly as shown — nothing is clamped. Change the discount
            if it was not intended.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
