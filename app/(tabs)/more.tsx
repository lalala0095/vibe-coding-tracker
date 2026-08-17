// More — the shelf for everything that does not earn a tab of its own.
//
// The bottom bar holds three tabs because a fourth and a fifth make each one a
// smaller target, and the app is still growing (Trackers, Invoices). Anything
// that is browsed rather than lived in gets a row here and is *pushed* as a
// stack route, so it arrives with a header and a back button rather than
// competing for width in the bar.
//
// Rows are added here only once the screen behind them exists and is reachable.
// A row that leads nowhere is worse than no row at all.

import { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { useAuth } from '@/auth';
import { Button, Card, ErrorNote, Screen } from '@/components';

interface MoreRow {
  label: string;
  hint: string;
  /** Checked by hand against a file in `app/` — see the note in `_layout.tsx`. */
  href: string;
}

const ROWS: MoreRow[] = [
  // Directly above Time Entries: the two are the same kind of thing seen from
  // either end — a block of work, and the hours that come out of it.
  { label: 'Trackers', hint: 'Every work block, running and finished.', href: '/trackers' },
  // "Time Entries", never "Sessions" — that word means `goals` on the web
  // (CLAUDE.md), which this app does not ship.
  { label: 'Time Entries', hint: 'Hours logged against tasks.', href: '/entries' },
  { label: 'Clients & Projects', hint: 'Who the work is for.', href: '/clients' },
];

export default function MoreScreen() {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');

  const handleSignOut = async () => {
    setError('');
    setSigningOut(true);
    try {
      // No navigation to do afterwards: dropping the session flips `status` to
      // `signed-out`, and the group's own guard in `(tabs)/_layout.tsx`
      // redirects to the sign-in screen. This component unmounts with it, which
      // is why `signingOut` is only ever cleared on the failure path.
      await signOut();
    } catch {
      setError('Could not sign out. Try again.');
      setSigningOut(false);
    }
  };

  const header = (
    <View className="border-b border-slate-800 px-4 pb-3 pt-1">
      <Text className="text-xl font-bold text-slate-100">More</Text>
      <Text className="mt-0.5 text-xs leading-relaxed text-slate-500">
        The rest of the tracker, and your account.
      </Text>
    </View>
  );

  return (
    <Screen header={header}>
      <Card padded={false}>
        {ROWS.map((row, index) => (
          <Pressable
            key={row.href}
            onPress={() => router.push(row.href)}
            accessibilityRole="button"
            accessibilityLabel={row.label}
            className={[
              'flex-row items-center gap-3 px-4 py-4 active:bg-slate-800',
              // Hairlines between rows only, so the card keeps its own border.
              index > 0 ? 'border-t border-slate-800' : '',
            ].join(' ')}
          >
            <View className="min-w-0 flex-1">
              <Text className="text-base font-medium text-slate-100">{row.label}</Text>
              <Text className="mt-0.5 text-xs text-slate-500">{row.hint}</Text>
            </View>
            {/* No icon library in this app — glyphs are text characters. */}
            <Text className="text-lg text-slate-500">›</Text>
          </Pressable>
        ))}
      </Card>

      <View className="gap-2">
        <Text className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          Account
        </Text>
        <Card>
          <Text className="text-base font-medium text-slate-100" numberOfLines={1}>
            {user?.name || 'Signed in'}
          </Text>
          {user?.email ? (
            <Text className="mt-0.5 text-sm text-slate-400" numberOfLines={1}>
              {user.email}
            </Text>
          ) : null}

          {error ? (
            <View className="mt-3">
              <ErrorNote message={error} />
            </View>
          ) : null}

          <View className="mt-4">
            <Button
              label="Sign out"
              variant="secondary"
              onPress={handleSignOut}
              loading={signingOut}
              testID="sign-out"
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}
