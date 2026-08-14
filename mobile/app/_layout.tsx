import '../global.css';

import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '@/auth';

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

export default function RootLayout() {
  return (
    // Outermost, so every route — including anything added outside the tab
    // group later — can call `useAuth()`.
    <AuthProvider>
      <SafeAreaProvider>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: '#020617' },
            }}
          />
        </ThemeProvider>
      </SafeAreaProvider>
    </AuthProvider>
  );
}
