// A Singapore calendar day and its entries, with the day's total.
//
// The day is the unit invoices bill by, so it is the unit worth checking your
// own work against. The total is `sumHours` over `effective_hours` exactly as
// the server returned each one — added up, never recomputed, never re-rounded.

import { Text, View } from 'react-native';

import { formatHoursLabel } from '@/lib/hours';
import type { TimeEntry } from '@/types';
import EntryRow from './EntryRow';
import { formatDayHeading } from './grouping';

export interface DayGroupProps {
  /** `YYYY-MM-DD` in Singapore time, or `UNDATED`. */
  day: string;
  entries: TimeEntry[];
  hours: number;
  onEdit: (entry: TimeEntry) => void;
  onDelete: (entry: TimeEntry) => void;
}

export default function DayGroup({ day, entries, hours, onEdit, onDelete }: DayGroupProps) {
  return (
    <View className="gap-2">
      <View className="flex-row items-baseline justify-between gap-3 px-0.5">
        <Text className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          {formatDayHeading(day)}
        </Text>
        <Text className="text-xs tabular-nums text-slate-500">{formatHoursLabel(hours)}</Text>
      </View>

      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          onEdit={() => onEdit(entry)}
          onDelete={() => onDelete(entry)}
        />
      ))}
    </View>
  );
}
