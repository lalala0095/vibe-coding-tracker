// One previewed line, with its tick.
//
// Every line the preview returns is listed and every line is tickable —
// including the ones that arrive with `include_by_default: false`. That flag is
// advice, not a rule: it means ticking the line would double-bill, or that a
// tracker is still running so there are no hours to derive yet. The reason is
// printed in amber and the decision stays with the user (CLAUDE.md, § no
// locking — warn, never block).
//
// Nothing here computes money. `hours`, `rate` and `amount` are shown as the
// server previewed them.

import { Pressable, Text, View } from 'react-native';

import { formatHours } from '@/lib/money';
import { money, periodLabel } from '@/screens/invoices/invoiceMeta';
import type { InvoicePreviewLine } from '@/types';

export interface PreviewLineRowProps {
  line: InvoicePreviewLine;
  currency: string;
  included: boolean;
  onToggle: () => void;
}

export default function PreviewLineRow({
  line,
  currency,
  included,
  onToggle,
}: PreviewLineRowProps) {
  const flagged = line.include_by_default === false;
  const fromTracker = line.source === 'tracker';

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: included }}
      className={`flex-row items-start gap-3 rounded-lg border px-3 py-3 ${
        included
          ? 'border-violet-500/50 bg-violet-500/5'
          : 'border-slate-800 bg-slate-950 active:bg-slate-800'
      }`}
    >
      <Text className={`text-base ${included ? 'text-violet-400' : 'text-slate-600'}`}>
        {included ? '☑' : '☐'}
      </Text>

      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-start gap-2">
          <Text className="min-w-0 flex-1 text-sm text-slate-100" numberOfLines={2}>
            {line.description || line.task_title || 'Untitled line'}
          </Text>
          <Text className="text-sm tabular-nums text-slate-100">
            {money(line.amount, currency)}
          </Text>
        </View>

        <View className="flex-row flex-wrap items-center gap-x-2">
          <Text className="text-xs text-slate-500" numberOfLines={1}>
            {line.project_name || 'No project'}
          </Text>
          <Text className="text-xs text-slate-600">·</Text>
          <Text className="text-xs tabular-nums text-slate-500">
            {periodLabel(line.date_from, line.date_to)}
          </Text>
        </View>

        <View className="flex-row flex-wrap items-center gap-x-2">
          <Text className="text-xs tabular-nums text-slate-400">{formatHours(line.hours)}</Text>
          <Text className="text-xs text-slate-600">×</Text>
          <Text className="text-xs tabular-nums text-slate-400">
            {money(line.rate, currency)}
          </Text>
          {fromTracker ? (
            <Text className="text-xs text-indigo-300">· from a tracker</Text>
          ) : null}
        </View>

        {/* The sub-items a task line prints as a bullet list. Shown so an
            unticked line can be judged on what it actually contains. */}
        {line.sub_items?.length ? (
          <Text className="text-xs text-slate-500" numberOfLines={3}>
            {line.sub_items.map((item) => `• ${item}`).join('\n')}
          </Text>
        ) : null}

        {flagged ? (
          <Text className="text-xs leading-relaxed text-amber-300">
            {line.duplicate_reason ??
              'Flagged by the preview — ticking this may bill hours twice.'}
          </Text>
        ) : null}

        {line.claimed_by?.length ? (
          <Text className="text-xs text-amber-300/80">
            Already billed on {line.claimed_by.join(', ')}.
          </Text>
        ) : null}

        {flagged && included ? (
          <Text className="text-xs text-amber-300/80">
            Ticked anyway — it will be billed exactly as shown.
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
