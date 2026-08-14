// The one interval in this app.
//
// ── Why it is shaped like this ────────────────────────────────────────────────
//
// A phone must not tick a timer it is not showing. `useFocusEffect` runs its
// effect when the screen gains focus and its cleanup when the screen **blurs or
// unmounts** — both, which is exactly the lifecycle a tab bar needs: switching
// to Entries stops the interval, switching back restarts it. A plain
// `useEffect` would keep counting behind the other two tabs.
//
// The elapsed figure is derived, not accumulated: every tick just re-reads the
// clock, so a stretch spent blurred (or with the screen off) costs nothing but
// a missed repaint. There is no background task and no notification — an
// interval that is not running cannot drift.

import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

/**
 * A `Date` that refreshes once a second while the screen is focused.
 *
 * @param enabled `false` freezes it — a stopped tracker has a fixed end time,
 *                so there is nothing to re-render for.
 */
export function useTick(enabled: boolean): Date {
  const [now, setNow] = useState(() => new Date());

  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;

      // Re-read immediately: coming back after a blur must not show the stale
      // second the screen left on.
      setNow(new Date());
      const id = setInterval(() => setNow(new Date()), 1000);
      return () => clearInterval(id);
    }, [enabled]),
  );

  return now;
}
