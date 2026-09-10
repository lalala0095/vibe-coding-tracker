// The note the panel and the form both warn in, so they warn in one voice.
//
// Amber is "unusual, probably deliberate". Red is "almost certainly a mistake".
// Neither has ever blocked a value: an overpayment, a negative amount, a
// missing currency — each draws one of these and is still saved exactly as
// entered (CLAUDE.md, § no locking, and § Money rules 4).

import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

export interface PaymentWarningProps {
  tone?: 'amber' | 'red';
  title: string;
  children?: ReactNode;
}

export default function PaymentWarning({
  tone = 'amber',
  title,
  children,
}: PaymentWarningProps) {
  const shell =
    tone === 'red'
      ? 'border-red-400/30 bg-red-400/10'
      : 'border-amber-400/30 bg-amber-400/10';
  const head = tone === 'red' ? 'text-red-300' : 'text-amber-300';
  const body = tone === 'red' ? 'text-red-400/80' : 'text-amber-300/70';

  return (
    <View className={`flex-row items-start gap-2.5 rounded-lg border px-3 py-2.5 ${shell}`}>
      <Text className={`text-xs ${head}`}>⚠</Text>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className={`text-xs font-medium leading-relaxed ${head}`}>{title}</Text>
        {children ? (
          <Text className={`text-xs leading-relaxed ${body}`}>{children}</Text>
        ) : null}
      </View>
    </View>
  );
}
