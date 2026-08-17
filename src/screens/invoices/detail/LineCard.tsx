// One invoice line, editable.
//
// ── No locking ───────────────────────────────────────────────────────────────
//
// Description, both dates, hours and rate stay editable on every invoice —
// draft, sent, paid or void. CLAUDE.md is explicit that a sent or paid invoice
// is not a reason to disable a field, and `back/routers/invoices.py` agrees:
// *"A sent or paid invoice is editable like any other; status never blocks a
// change."* Where something is worth flagging, the field carries a `warning`
// and the user decides.
//
// ── Snapshots ────────────────────────────────────────────────────────────────
//
// `task_title`, `project_name` and `sub_items` are printed from the line, not
// looked up. `rate` was resolved once when the invoice was built — client
// default, then project rate, then any override — and frozen. Raising the
// client's rate tomorrow must not rewrite this line, so nothing here re-reads
// it from anywhere.

import { Pressable, Text, View } from 'react-native';

import { Card, DateTimeField, NumberField, TextField } from '@/components';
import { money } from '@/screens/invoices/invoiceMeta';
import { dayFromFieldValue, type LineDraft } from '@/screens/invoices/detail/draft';

export interface LineCardProps {
  line: LineDraft;
  /** Patch of the fields that changed. */
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
  /**
   * The amount to show. The server's stored figure while the draft is clean,
   * the live `computeMoney` preview once it is not — never a figure this card
   * worked out for itself.
   */
  amount: number;
  /** True when `amount` is the unsaved preview rather than the stored value. */
  preview: boolean;
  currency: string;
}

export default function LineCard({
  line,
  onChange,
  onRemove,
  amount,
  preview,
  currency,
}: LineCardProps) {
  const title = line.task_title.trim() || line.description.trim() || 'Manual line';

  // String comparison is exact for `YYYY-MM-DD`, and no `Date` is constructed —
  // so there is no timezone in this check at all.
  const backwards =
    line.date_from !== null && line.date_to !== null && line.date_from > line.date_to;

  const provenance =
    line.tracker_id !== null
      ? 'Billed from a tracker'
      : line.session_ids.length > 0
        ? `From ${line.session_ids.length} time ${line.session_ids.length === 1 ? 'entry' : 'entries'}`
        : 'Added by hand';

  return (
    <Card>
      <View className="flex-row items-start justify-between gap-2">
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-slate-100" numberOfLines={2}>
            {title}
          </Text>
          <Text className="mt-0.5 text-xs text-slate-500" numberOfLines={1}>
            {line.project_name ? `${line.project_name} · ` : ''}
            {provenance}
          </Text>
        </View>
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel="Remove line"
          hitSlop={8}
          className="rounded-lg px-2 py-1 active:bg-slate-800"
        >
          <Text className="text-xs font-medium text-red-400">Remove</Text>
        </Pressable>
      </View>

      {line.sub_items.length > 0 ? (
        <View className="mt-2 gap-0.5">
          {line.sub_items.map((item, index) => (
            <Text key={`${index}-${item}`} className="text-xs text-slate-400" numberOfLines={1}>
              • {item}
            </Text>
          ))}
        </View>
      ) : null}

      <View className="mt-3 gap-3">
        <TextField
          label="Description"
          value={line.description}
          onChangeText={(description) => onChange({ description })}
          placeholder={line.task_title || 'What this line bills'}
          hint={
            line.description.trim().length === 0 && line.task_title
              ? 'Left blank, this prints the task title.'
              : undefined
          }
        />

        <View className="flex-row gap-3">
          <DateTimeField
            className="flex-1"
            label="From"
            mode="date"
            clearable
            value={line.date_from}
            onChange={(value) => onChange({ date_from: dayFromFieldValue(value) })}
            warning={backwards ? 'Starts after it ends.' : undefined}
          />
          <DateTimeField
            className="flex-1"
            label="To"
            mode="date"
            clearable
            value={line.date_to}
            onChange={(value) => onChange({ date_to: dayFromFieldValue(value) })}
          />
        </View>

        <View className="flex-row gap-3">
          <NumberField
            className="flex-1"
            label="Hours"
            suffix="h"
            value={line.hours}
            onChangeText={(hours) => onChange({ hours })}
          />
          <NumberField
            className="flex-1"
            label="Rate"
            suffix={currency}
            value={line.rate}
            onChangeText={(rate) => onChange({ rate })}
            hint="Fixed when this invoice was built."
          />
        </View>
      </View>

      <View className="mt-3 flex-row items-baseline justify-between border-t border-slate-800 pt-2">
        <Text className="text-xs text-slate-500">{preview ? 'Amount (unsaved)' : 'Amount'}</Text>
        <Text
          className={`text-base font-semibold tabular-nums ${
            preview ? 'text-amber-300' : 'text-slate-100'
          }`}
        >
          {money(amount, currency)}
        </Text>
      </View>
    </Card>
  );
}
