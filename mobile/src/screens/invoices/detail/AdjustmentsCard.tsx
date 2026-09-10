// Discount and tax.
//
// Both are inputs to the server's arithmetic, not results of it: the endpoint
// recomputes `discount_amount`, `tax_amount` and `total` from whatever is sent
// here. The figures they produce live in the totals block.
//
// Tax applies to the **discounted** subtotal, not the raw one (CLAUDE.md money
// rule 3). That ordering is inside `computeMoney` and inside the backend; this
// card only says so in words, so the percentage on screen is not misread.

import { Text, View } from 'react-native';

import { NumberField, Select, TextField } from '@/components';
import type { InvoiceDraft } from '@/screens/invoices/detail/draft';

export interface AdjustmentsCardProps {
  draft: InvoiceDraft;
  onChange: (patch: Partial<InvoiceDraft>) => void;
  currency: string;
  /** Discount exceeds the subtotal — warned about here too, never blocked. */
  overDiscounted: boolean;
}

const DISCOUNT_OPTIONS = [
  { label: 'Percent of subtotal', value: 'percent' },
  { label: 'Fixed amount', value: 'amount' },
];

export default function AdjustmentsCard({
  draft,
  onChange,
  currency,
  overDiscounted,
}: AdjustmentsCardProps) {
  return (
    <View className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
        Discount &amp; tax
      </Text>

      <View className="mt-3 gap-3">
        <Select
          label="Discount"
          value={draft.discount_type}
          onChange={(value) =>
            onChange({ discount_type: value as InvoiceDraft['discount_type'] })
          }
          options={DISCOUNT_OPTIONS}
          placeholder="No discount"
          noneLabel="No discount"
          title="Discount type"
          testID="invoice-discount-type"
        />

        {draft.discount_type !== null ? (
          <NumberField
            label={draft.discount_type === 'percent' ? 'Discount percent' : 'Discount amount'}
            suffix={draft.discount_type === 'percent' ? '%' : currency}
            value={draft.discount_value}
            onChangeText={(discount_value) => onChange({ discount_value })}
            warning={
              overDiscounted
                ? 'Larger than the subtotal — the total goes negative. Nothing is clamped.'
                : undefined
            }
          />
        ) : null}

        <View className="flex-row gap-3">
          <TextField
            className="flex-1"
            label="Tax label"
            value={draft.tax_label}
            onChangeText={(tax_label) => onChange({ tax_label })}
            placeholder="GST"
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <NumberField
            className="w-32"
            label="Tax percent"
            suffix="%"
            value={draft.tax_percent}
            onChangeText={(tax_percent) => onChange({ tax_percent })}
          />
        </View>

        <Text className="text-xs leading-relaxed text-slate-500">
          Tax is applied to the subtotal after the discount, not before it.
        </Text>
      </View>
    </View>
  );
}
