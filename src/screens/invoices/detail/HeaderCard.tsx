// Who this invoice is, and what state it is in.
//
// ── Everything here is a snapshot ────────────────────────────────────────────
//
// `bill_to` and `issued_by` were copied onto the invoice when it was created
// and are printed from it. They are not re-fetched from the client or from
// Invoice Settings, and they must not be: editing the issuer's address next
// month cannot be allowed to rewrite what a sent invoice said. Same reasoning
// as every line's `task_title` and `rate`.
//
// ── Status ───────────────────────────────────────────────────────────────────
//
// Set through `PATCH /invoices/{id}/status`, its own endpoint, so it does not
// travel with an edit. Every status stays reachable from every other — there is
// no lock-out on `paid`, and marking something `void` is not a one-way door.

import { Text, View } from 'react-native';

import { Chip } from '@/components';
import { formatHours } from '@/lib/money';
import {
  INVOICE_STATUSES,
  money,
  periodLabel,
  STATUS_LABEL,
  STATUS_TONE,
} from '@/screens/invoices/invoiceMeta';
import type { Invoice, InvoiceStatus } from '@/types';

export interface HeaderCardProps {
  invoice: Invoice;
  onStatusChange: (status: InvoiceStatus) => void;
  /** True while a status change is in flight. */
  statusBusy: boolean;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3">
      <Text className="text-xs text-slate-500">{label}</Text>
      <Text className="min-w-0 flex-1 text-right text-sm text-slate-200" numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/** A multi-line snapshot block — `bill_to` is newline separated. */
function Block({ label, value }: { label: string; value: string }) {
  const text = value.trim();
  return (
    <View className="gap-1">
      <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</Text>
      <Text className="text-sm leading-relaxed text-slate-200">{text || '—'}</Text>
    </View>
  );
}

export default function HeaderCard({ invoice, onStatusChange, statusBusy }: HeaderCardProps) {
  const issuedBy = [
    invoice.issued_by?.business_name,
    invoice.issued_by?.contact_name,
    invoice.issued_by?.address,
    invoice.issued_by?.email,
  ]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join('\n');

  const projects = (invoice.project_names || []).filter((name) => name.trim().length > 0);

  return (
    <View className="gap-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <View>
        <Text className="text-xl font-bold text-slate-100" numberOfLines={1}>
          {invoice.invoice_number || 'No number'}
        </Text>
        <Text className="mt-0.5 text-sm text-slate-300" numberOfLines={1}>
          {invoice.client_name || 'Unknown client'}
        </Text>
        {projects.length > 0 ? (
          <Text className="text-xs text-slate-500" numberOfLines={2}>
            {projects.join(', ')}
          </Text>
        ) : null}
      </View>

      <View className={`flex-row flex-wrap gap-2 ${statusBusy ? 'opacity-50' : ''}`}>
        {INVOICE_STATUSES.map((value) => {
          const active = value === invoice.status;
          return (
            <Chip
              key={value}
              label={STATUS_LABEL[value]}
              size="md"
              tone={active ? STATUS_TONE[value] : 'slate'}
              className={active ? '' : 'opacity-60'}
              onPress={() => onStatusChange(value)}
              testID={`invoice-status-${value}`}
            />
          );
        })}
      </View>

      <View className="gap-1.5 border-t border-slate-800 pt-3">
        <Field label="Period" value={periodLabel(invoice.period_start, invoice.period_end)} />
        <Field label="Issued" value={invoice.issue_date || '—'} />
        <Field label="Due" value={invoice.due_date || 'No due date'} />
        <Field label="Currency" value={invoice.currency || '—'} />
        <Field label="Billed hours" value={formatHours(invoice.total_hours)} />
        <Field label="Total" value={money(invoice.total, invoice.currency)} />
      </View>

      <View className="gap-3 border-t border-slate-800 pt-3">
        <Block label="Bill to" value={invoice.bill_to ?? ''} />
        <Block label="Issued by" value={issuedBy} />
        <Text className="text-[11px] leading-relaxed text-slate-500">
          Both were copied onto this invoice when it was created. Changing the client or the
          issuer details later will not rewrite them.
        </Text>
      </View>
    </View>
  );
}
