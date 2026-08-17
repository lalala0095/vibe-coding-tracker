// The three tabs, and the gate in front of them.
//
// Every screen in this group calls the API on mount, so an unauthenticated
// render here is three failed requests and three error notes. The redirect
// below is what stops that.

import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/auth';
import { LoadingBlock, Screen } from '@/components';
import { colors } from '@/theme';

// ── The tab bar and the gesture bar ──────────────────────────────────────────
//
// Android 15 enforces edge-to-edge: the app draws behind the system bars, and
// the home/gesture bar is painted *over* the bottom of the window. A tab bar
// given a fixed `height` with no bottom inset therefore ends up with its lower
// strip — including part of every tab's touch target — underneath that gesture
// area, where taps go to the system instead of to us. On a Samsung device with
// gesture navigation that is the difference between "fiddly" and "unusable".
//
// The two numbers below describe the bar *itself*; the system inset is added on
// top of both, so the interactive row always clears the gesture bar:
//
//   height        = 60 + insets.bottom
//   paddingBottom =  8 + insets.bottom
//
// With no inset (0 — three-button navigation, or a device that reports none)
// they resolve to 60 / 8, exactly what this file used to hardcode. With a
// typical 24dp gesture inset they resolve to 84 / 32, and with a 48dp one to
// 108 / 56. Nothing here is a magic number tuned to one handset.
//
// Worth knowing while reading this next to `src/components/Screen.tsx`: growing
// the bar does *not* strand dead space above it. `SafeAreaView`'s Android
// implementation measures the inset that overlaps the view's own rectangle
// (`SafeAreaUtils.getSafeAreaInsets`), so a screen whose bottom edge already
// stops short of the window bottom resolves its bottom inset to 0 on its own.
const BAR_HEIGHT = 60;
const BAR_PADDING_BOTTOM = 8;

export default function TabsLayout() {
  const { status } = useAuth();
  // Called before the early returns below — the rules of hooks do not care that
  // the value is unused on those paths.
  const insets = useSafeAreaInsets();

  if (status === 'restoring') {
    return (
      <Screen className="flex-1 items-center justify-center px-4">
        <LoadingBlock />
      </Screen>
    );
  }

  if (status !== 'signed-in') {
    return <Redirect href="/sign-in" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // A tab bar takes colour *values*, not classes — one of the legitimate
        // uses of `theme.ts` (see the header comment there).
        tabBarActiveTintColor: colors.blue500,
        tabBarInactiveTintColor: colors.slate500,
        tabBarStyle: {
          backgroundColor: colors.slate900,
          borderTopColor: colors.slate800,
          borderTopWidth: 1,
          // The stock elevation shadow reads as a grey smear on slate-900.
          elevation: 0,
          height: BAR_HEIGHT + insets.bottom,
          paddingTop: 6,
          paddingBottom: BAR_PADDING_BOTTOM + insets.bottom,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '500',
        },
        // No icon library in this app (Task C). Labels carry the tabs, so the
        // space an icon would occupy goes to the label instead.
        tabBarIconStyle: { display: 'none' },
      }}
    >
      <Tabs.Screen name="now" options={{ title: 'Now' }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks' }} />
      {/* Time Entries and Clients & Projects live behind this one as pushed
          stack routes. Three tabs plus an overflow shelf beats six tabs, and it
          leaves room for Trackers and Invoices to arrive without another
          re-shuffle. */}
      <Tabs.Screen name="more" options={{ title: 'More' }} />
    </Tabs>
  );
}
