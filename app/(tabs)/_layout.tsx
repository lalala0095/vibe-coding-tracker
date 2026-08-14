// The three tabs, and the gate in front of them.
//
// Every screen in this group calls the API on mount, so an unauthenticated
// render here is three failed requests and three error notes. The redirect
// below is what stops that.

import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';

import { useAuth } from '@/auth';
import { LoadingBlock, Screen } from '@/components';
import { colors } from '@/theme';

export default function TabsLayout() {
  const { status } = useAuth();

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
          height: 60,
          paddingTop: 6,
          paddingBottom: 8,
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
      {/* "Time Entries", never "Sessions" — that word means `goals` on the
          web (CLAUDE.md). Shortened to "Entries" only because it is a tab. */}
      <Tabs.Screen name="entries" options={{ title: 'Entries' }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks' }} />
    </Tabs>
  );
}
