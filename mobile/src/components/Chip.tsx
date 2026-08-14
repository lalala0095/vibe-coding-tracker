// A pill badge: task status, priority, a filter, an `invoice_number`.
//
// The tone classes are written out in full rather than composed from the tone
// name. NativeWind extracts classes from the source at build time, so
// `` `bg-${tone}-500/15` `` compiles to nothing at all.

import { Pressable, Text, View } from 'react-native';

export type ChipTone = 'slate' | 'violet' | 'indigo' | 'blue' | 'green' | 'amber' | 'red';
export type ChipSize = 'sm' | 'md';

export interface ChipProps {
  label: string;
  tone?: ChipTone;
  size?: ChipSize;
  /** Makes the chip tappable — the tap-to-cycle task status gesture. */
  onPress?: () => void;
  className?: string;
  testID?: string;
}

const SURFACE: Record<ChipTone, string> = {
  slate: 'bg-slate-500/15 border-slate-500/30',
  violet: 'bg-violet-500/15 border-violet-500/30',
  indigo: 'bg-indigo-500/15 border-indigo-500/30',
  blue: 'bg-blue-500/15 border-blue-500/30',
  green: 'bg-green-500/15 border-green-500/30',
  amber: 'bg-amber-500/15 border-amber-500/30',
  red: 'bg-red-500/15 border-red-500/30',
};

const PRESSED: Record<ChipTone, string> = {
  slate: 'active:bg-slate-500/30',
  violet: 'active:bg-violet-500/30',
  indigo: 'active:bg-indigo-500/30',
  blue: 'active:bg-blue-500/30',
  green: 'active:bg-green-500/30',
  amber: 'active:bg-amber-500/30',
  red: 'active:bg-red-500/30',
};

const LABEL: Record<ChipTone, string> = {
  slate: 'text-slate-300',
  violet: 'text-violet-300',
  indigo: 'text-indigo-300',
  blue: 'text-blue-300',
  green: 'text-green-300',
  amber: 'text-amber-300',
  red: 'text-red-300',
};

const SIZE: Record<ChipSize, string> = {
  sm: 'px-2 py-0.5 rounded-md',
  md: 'px-2.5 py-1 rounded-lg',
};

const SIZE_LABEL: Record<ChipSize, string> = {
  sm: 'text-[11px]',
  md: 'text-xs',
};

export default function Chip({
  label,
  tone = 'slate',
  size = 'sm',
  onPress,
  className = '',
  testID,
}: ChipProps) {
  const body = (
    <Text className={`font-medium ${SIZE_LABEL[size]} ${LABEL[tone]}`} numberOfLines={1}>
      {label}
    </Text>
  );

  const classes = `self-start border ${SIZE[size]} ${SURFACE[tone]} ${className}`;

  if (!onPress) {
    return (
      <View className={classes} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={6}
      className={`${classes} ${PRESSED[tone]}`}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}
