import '../global.css';

import { DarkTheme, Stack, ThemeProvider, type NativeStackHeaderProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthProvider } from '@/auth';
import { colors } from '@/theme';

// The web app has no light mode and neither does this one; the palette is the
// slate-950 / slate-900 dark theme from `front/`.
const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: '#020617', // slate-950
    card: '#0f172a', // slate-900
    border: '#1e293b', // slate-800
    text: '#f1f5f9', // slate-100
    primary: '#2563eb', // blue-600
  },
};

// ── Which routes get a header ────────────────────────────────────────────────
//
// The tab group owns its own chrome and must stay headerless; so must `index`
// (a redirect that renders nothing) and `sign-in`. Everything reached by
// *pushing* — the rows on the More tab — needs a title and a way back.
//
// This is a title map rather than a set of `<Stack.Screen>` children on
// purpose. Declaring a screen for a route file that does not exist yet is an
// error at render time, and `app/clients.tsx` is landing separately; a map
// entry is inert until the file appears, then supplies the right title the
// moment it does. A route that sets its own `title` still wins, because
// `screenOptions` is the floor and per-screen options are layered over it.
//
// Keys are route names, which for a file at `app/<name>.tsx` is `<name>`.
const PUSHED_TITLES: Record<string, string> = {
  entries: 'Time Entries',
  clients: 'Clients & Projects',
};

/**
 * The header for pushed routes.
 *
 * A JS header rather than the native Android toolbar, for one reason: the
 * toolbar has no border, and the divider under it is the only thing separating
 * `bg-slate-900` chrome from a `bg-slate-950` page. Its elevation shadow is the
 * native alternative and it reads as a grey smear on slate, the same problem
 * `elevation: 0` solves on the tab bar.
 *
 * The cost of owning the header is owning the status bar inset with it: this
 * view is flush against the top of the window, so the raw window inset from
 * `useSafeAreaInsets()` is exactly the padding it needs. Below the header the
 * screen's own `SafeAreaView` measures a top inset of 0 by itself — Android's
 * implementation only counts the part of an inset that actually overlaps the
 * view — so nothing double-counts.
 */
function StackHeader({ back, navigation, options, route }: NativeStackHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View className="border-b border-slate-800 bg-slate-900" style={{ paddingTop: insets.top }}>
      <View className="h-14 flex-row items-center px-2">
        {back ? (
          <Pressable
            onPress={navigation.goBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            // 48dp of target plus slop, which is the Android minimum rather
            // than the size of the glyph inside it.
            hitSlop={8}
            className="h-12 w-12 items-center justify-center rounded-full active:bg-slate-800"
          >
            {/* No icon library in this app — glyphs are text characters. */}
            <Text className="text-2xl leading-none text-slate-100">←</Text>
          </Pressable>
        ) : (
          <View className="w-2" />
        )}
        <Text
          className="ml-1 min-w-0 flex-1 text-lg font-semibold text-slate-100"
          numberOfLines={1}
        >
          {options.title ?? route.name}
        </Text>
      </View>
    </View>
  );
}

export default function RootLayout() {
  return (
    // Outermost, so every route — including anything added outside the tab
    // group later — can call `useAuth()`.
    <AuthProvider>
      <SafeAreaProvider>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style="light" />
          <Stack
            screenOptions={({ route }) => {
              const title = PUSHED_TITLES[route.name];
              return {
                // Opt-in, not a denylist: a new route is headerless until it is
                // given a title here, which is the safe direction to fail in.
                headerShown: title !== undefined,
                title,
                header: (props: NativeStackHeaderProps) => <StackHeader {...props} />,
                contentStyle: { backgroundColor: colors.slate950 },
              };
            }}
          />
        </ThemeProvider>
      </SafeAreaProvider>
    </AuthProvider>
  );
}
