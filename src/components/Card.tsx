// The card surface — `bg-slate-900` on the `bg-slate-950` page, the same
// pairing every panel in `front/` uses.

import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

export interface CardProps {
  children: ReactNode;
  /** Makes the whole card a tap target with a pressed state. */
  onPress?: () => void;
  onLongPress?: () => void;
  /** `false` drops the inner padding, for a card whose children own it. */
  padded?: boolean;
  /** A violet ring — the running tracker, the selected row. */
  highlight?: boolean;
  /** Extra classes, appended so they win over the defaults. */
  className?: string;
  testID?: string;
}

const BASE = 'rounded-xl border bg-slate-900';

export default function Card({
  children,
  onPress,
  onLongPress,
  padded = true,
  highlight = false,
  className = '',
  testID,
}: CardProps) {
  const border = highlight ? 'border-violet-500/60' : 'border-slate-800';
  const padding = padded ? 'p-4' : '';
  const classes = `${BASE} ${border} ${padding} ${className}`;

  if (!onPress && !onLongPress) {
    return (
      <View className={classes} testID={testID}>
        {children}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      className={`${classes} active:bg-slate-800 active:border-slate-700`}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}
