import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Vibe Tracker',
  slug: 'vibe-coding-tracker',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'vibetracker',
  // The whole app is the dark slate theme carried over from `front/`; there is no
  // light variant to switch to, so do not let the OS pick one.
  userInterfaceStyle: 'dark',
  // No `newArchEnabled` key: SDK 57 removed it from ExpoConfig because the New
  // Architecture is the only architecture — there is nothing left to opt into.
  platforms: ['android'],
  android: {
    package: 'com.lalala0095.vibetracker',
    adaptiveIcon: {
      backgroundColor: '#020617',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#020617',
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
      },
    ],
    // Excludes the keystore-backed session token from Android Auto Backup, so a
    // bearer credential does not ride out to Google Drive with the app's data.
    'expo-secure-store',
    // Bare string on purpose. The options form takes only `iosUrlScheme` and
    // *throws* without it — this app is Android-only. With no options the plugin
    // runs its Firebase path, and every step of that path is a no-op unless
    // `android.googleServicesFile` is set (verified in
    // `@expo/config-plugins/build/android/GoogleServices.js`): no google-services
    // gradle plugin, no missing-file build failure. The native module is what
    // matters; the Android OAuth client lives in the GCP console, not here.
    '@react-native-google-signin/google-signin',
    // Darkens the Android date/time dialogs. Without it they render as a white
    // `Theme.AppCompat.Light.Dialog` popping out of a slate-950 app — the
    // library's `accentColor`/`textColor` props are iOS-only, so this plugin is
    // the only lever. A `light` value is required for every attribute or it
    // throws at prebuild; every attribute name below is on its allow-list.
    [
      '@react-native-community/datetimepicker',
      {
        android: {
          datePicker: {
            colorAccent: { light: '#8b5cf6', dark: '#8b5cf6' }, // violet-500
            textColorPrimary: { light: '#f1f5f9', dark: '#f1f5f9' }, // slate-100
            windowBackground: { light: '#0f172a', dark: '#0f172a' }, // slate-900
          },
          timePicker: {
            background: { light: '#0f172a', dark: '#0f172a' },
            numbersTextColor: { light: '#f1f5f9', dark: '#f1f5f9' },
            numbersSelectorColor: { light: '#8b5cf6', dark: '#8b5cf6' },
          },
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    // TODO: set by `eas init`
    // eas: { projectId: '...' },
  },
};

export default config;
