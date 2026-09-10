// The two filters above the invoice list: status, and which client.
//
// Both are sent to `GET /invoices` rather than applied on the phone. The
// endpoint takes them as query params, and an invoice list is the one list here
// that grows without bound — every month adds rows and none are ever archived,
// so filtering server-side is the shape that keeps working.

import { View } from 'react-native';

import { Chip, Select } from '@/components';
import { STATUS_FILTERS, type StatusFilter } from '@/screens/invoices/list/invoiceRows';
import type { Client } from '@/types';

export interface InvoiceFiltersProps {
  status: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
  clientId: string | null;
  onClientChange: (clientId: string | null) => void;
  clients: Client[];
}

export default function InvoiceFilters({
  status,
  onStatusChange,
  clientId,
  onClientChange,
  clients,
}: InvoiceFiltersProps) {
  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap gap-2">
        {STATUS_FILTERS.map(([value, label]) => {
          const active = value === status;
          return (
            <Chip
              key={value}
              label={label}
              size="md"
              tone={active ? 'violet' : 'slate'}
              className={active ? '' : 'opacity-60'}
              onPress={() => onStatusChange(value)}
              testID={`invoices-filter-${value}`}
            />
          );
        })}
      </View>

      <Select
        value={clientId}
        onChange={onClientChange}
        options={clients.map((client) => ({
          label: client.name,
          value: client.id,
          sublabel: client.currency,
        }))}
        placeholder="All clients"
        noneLabel="All clients"
        title="Client"
        emptyLabel="No clients yet."
        testID="invoices-client-filter"
      />
    </View>
  );
}
