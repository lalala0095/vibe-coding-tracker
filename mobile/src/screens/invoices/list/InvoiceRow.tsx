// One invoice in the list.
//
// Every figure on this card is printed exactly as the server sent it —
// `formatMoney` and `formatHours` format an already-computed number and never
// round one into existence. `src/lib/money.ts` is not called here at all: there
// is nothing being edited on a list row, so there is nothing to preview.

import { Text, View } from 'react-native';

import { Card, Chip } from '@/components';
import { formatHours } from '@/lib/money';
import { money, periodLabel, STATUS_LABEL, STATUS_TONE } from '@/screens/invoices/invoiceMeta';
import { projectSummary, showsPayment } from '@/screens/invoices/list/invoiceRows';
import type { Invoice } from '@/types';

export interface InvoiceRowProps {
  invoice: Invoice;
  onPress: () => void;
}

export default function InvoiceRow({ invoice, onPress }: InvoiceRowProps) {
  const projects = projectSummary(invoice);
  const paid = showsPayment(invoice);

  return (
    <Card onPress={onPress} testID={`invoice-${invoice.id}`}>
      <View className="flex-row items-start justify-between gap-2">
        <View className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-slate-100" numberOfLines={1}>
            {invoice.invoice_number || 'No number'}
          </Text>
          <Text className="mt-0.5 text-sm text-slate-300" numberOfLines={1}>
            {invoice.client_name || 'Unknown client'}
          </Text>
          {projects ? (
            <Text className="text-xs text-slate-500" numberOfLines={1}>
              {projects}
            </Text>
          ) : null}
        </View>
        <Chip
          label={STATUS_LABEL[invoice.status]}
          tone={STATUS_TONE[invoice.status]}
          size="md"
        />
      </View>

      <View className="mt-3 flex-row items-baseline justify-between gap-2">
        <Text className="min-w-0 flex-1 text-xs text-slate-500" numberOfLines={1}>
          {periodLabel(invoice.period_start, invoice.period_end)}
        </Text>
        <Text className="text-base font-semibold tabular-nums text-slate-100">
          {money(invoice.total, invoice.currency)}
        </Text>
      </View>

      <View className="mt-0.5 flex-row items-baseline justify-between gap-2">
        <Text className="text-xs text-slate-500">Issued {invoice.issue_date || '—'}</Text>
        <Text className="text-xs tabular-nums text-slate-400">
          {formatHours(invoice.total_hours)}
        </Text>
      </View>

      {paid ? (
        <View className="mt-3 flex-row items-baseline justify-between gap-3 border-t border-slate-800 pt-2">
          <Text className="text-xs text-slate-500">
            Paid{' '}
            <Text className="tabular-nums text-green-300">
              {money(invoice.amount_paid, invoice.currency)}
            </Text>
          </Text>
          {/*
            `outstanding` is deliberately unclamped server-side: an overpayment
            reads negative. It is shown as it arrives — a discrepancy is the
            thing worth seeing, so the amber only marks money still owed.
          */}
          <Text className="text-xs text-slate-500">
            Outstanding{' '}
            <Text
              className={`tabular-nums ${
                invoice.outstanding > 0 ? 'text-amber-400' : 'text-slate-300'
              }`}
            >
              {money(invoice.outstanding, invoice.currency)}
            </Text>
          </Text>
        </View>
      ) : null}
    </Card>
  );
}
