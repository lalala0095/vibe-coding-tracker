import { useEffect, useState } from 'react';

/**
 * The current time in ms, refreshed every `intervalMs` while `active` — for
 * live-ticking running totals. Inactive, it holds its last value and schedules
 * nothing. The default 15 s keeps a floored minute display at most 15 s late.
 */
export function useNow(active: boolean, intervalMs = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
