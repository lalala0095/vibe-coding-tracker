// One time entry in the list.
//
// The whole card taps through to the editor; the only separate control is
// Delete, which is destructive enough to want its own target.
//
// An entry already pulled into an invoice shows a **chip**, not a lock. It stays
// tappable, and everything inside the editor stays editable (CLAUDE.md — warn
// visually, never block). Same for a running entry: `effective_hours` is 0 for
// it server-side, and 0 is what it shows. Nothing here invents a number.

import { Text, View } from 'react-native';

import { Button, Card, Chip } from '@/components';
import { formatHoursLabel } from '@/lib/hours';
import { formatSgtTime } from '@/lib/sgt';
import type { TimeEntry } from '@/types';
import { claimingInvoices } from './grouping';

export interface EntryRowProps {
  entry: TimeEntry;
  onEdit: () => void;
  onDelete: () => void;
}

export default function EntryRow({ entry, onEdit, onDelete }: EntryRowProps) {
  const running = entry.end_time === null;
  const invoices = claimingInvoices(entry);

  const span = running
    ? `${formatSgtTime(entry.start_time)} · still running`
    : `${formatSgtTime(entry.start_time)} – ${formatSgtTime(entry.end_time)}`;

  return (
    <Card onPress={onEdit} className="gap-2" testID={`entry-${entry.id}`}>
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-base text-slate-100" numberOfLines={2}>
            {entry.task_title}
          </Text>
          <Text className="mt-0.5 text-xs text-slate-500" numberOfLines={1}>
            {entry.client_name} / {entry.project_name}
          </Text>
          <Text className="mt-0.5 text-xs text-slate-400">{span}</Text>
        </View>

        <Text className="text-base font-semibold tabular-nums text-slate-100">
          {formatHoursLabel(entry.effective_hours)}
        </Text>
      </View>

      {entry.notes ? (
        <Text className="text-xs leading-relaxed text-slate-400" numberOfLines={3}>
          {entry.notes}
        </Text>
      ) : null}

      <View className="flex-row items-center gap-2">
        <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5">
          {running ? <Chip label="Running" tone="violet" /> : null}
          {entry.hours !== null ? <Chip label="Hours overridden" tone="indigo" /> : null}
          {!entry.billable ? <Chip label="Non-billable" tone="slate" /> : null}
          {invoices.length > 0 ? (
            <Chip label={`Invoiced · ${invoices.join(', ')}`} tone="amber" />
          ) : null}
        </View>

        <Button
          label="Delete"
          variant="ghost"
          fullWidth={false}
          textClassName="text-red-400"
          onPress={onDelete}
          testID={`entry-delete-${entry.id}`}
        />
      </View>
    </Card>
  );
}
