// Raw colour values — the escape hatch, not a styling system.
//
// Styling in this app is NativeWind classes, exactly as `front/` uses Tailwind
// classes, so that a colour is greppable across both codebases. A handful of
// React Native props take a colour *value* rather than a style, and there is no
// class that reaches them:
//
//   - `ActivityIndicator`'s `color`
//   - `RefreshControl`'s `tintColor` / `colors`
//   - `TextInput`'s `placeholderTextColor`, `selectionColor` and `cursorColor`
//   - the Android date/time picker's `accentColor` / `textColor`
//   - `StatusBar`
//
// Those are the only legitimate callers. **Do not add a StyleSheet here and do
// not reach for these values from a component that could have used a class** —
// two parallel palettes is exactly how the two codebases drift apart.
//
// Every value below is the stock Tailwind v3 scale, matching `front/`'s
// `bg-slate-950` page / `bg-slate-900` card / `border-slate-800` theme.

export const colors = {
  slate950: '#020617',
  slate900: '#0f172a',
  slate800: '#1e293b',
  slate700: '#334155',
  slate600: '#475569',
  slate500: '#64748b',
  slate400: '#94a3b8',
  slate300: '#cbd5e1',
  slate200: '#e2e8f0',
  slate100: '#f1f5f9',
  white: '#ffffff',

  blue700: '#1d4ed8',
  blue600: '#2563eb',
  blue500: '#3b82f6',
  blue400: '#60a5fa',

  violet500: '#8b5cf6',
  violet400: '#a78bfa',
  violet300: '#c4b5fd',

  indigo500: '#6366f1',
  indigo400: '#818cf8',
  indigo300: '#a5b4fc',

  green500: '#22c55e',
  green400: '#4ade80',
  green300: '#86efac',

  amber500: '#f59e0b',
  amber400: '#fbbf24',
  amber300: '#fcd34d',

  red600: '#dc2626',
  red500: '#ef4444',
  red400: '#f87171',
  red300: '#fca5a5',
} as const;

/** Semantic names for the few places above, so callers do not pick a shade. */
export const theme = {
  /** The page background — `bg-slate-950`. */
  background: colors.slate950,
  /** The card surface — `bg-slate-900`. */
  surface: colors.slate900,
  /** A raised surface above a card, e.g. a modal sheet. */
  surfaceRaised: colors.slate800,
  /** `border-slate-800`. */
  border: colors.slate800,
  /** `border-slate-700` — the stronger border used on inputs. */
  borderStrong: colors.slate700,

  /** `text-slate-100`. */
  text: colors.slate100,
  /** `text-slate-400`. */
  textMuted: colors.slate400,
  /** `text-slate-500` — placeholders and the faintest labels. */
  textFaint: colors.slate500,

  /** Primary action — `bg-blue-600`. */
  primary: colors.blue600,
  /** Destructive action — `bg-red-600`. */
  danger: colors.red600,
  /** Error text — `text-red-400`. */
  dangerText: colors.red400,
  /** Warning text — `text-amber-400`. Warn visually; never block (CLAUDE.md). */
  warningText: colors.amber400,
  /** The violet/indigo accent pair carried over from `front/`. */
  accent: colors.violet500,
  accentAlt: colors.indigo500,

  /** `ActivityIndicator` and `RefreshControl` on a dark surface. */
  spinner: colors.slate400,
  spinnerOnPrimary: colors.white,
  refreshTint: colors.violet400,

  /** `expo-status-bar` — there is no light mode. */
  statusBarStyle: 'light' as const,
} as const;

export type ThemeColor = keyof typeof colors;
