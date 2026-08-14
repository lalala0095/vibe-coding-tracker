// Google Sign-In, session persistence, and the recovery path when the server
// stops accepting a token.
//
// Shaped like `front/src/auth.tsx` — a provider plus a `useAuth()` hook — with
// two deliberate departures, both explained where they happen:
//
//   1. The token lives in `expo-secure-store`, not `localStorage`. It is a
//      bearer credential and `AsyncStorage` is plaintext on disk.
//   2. There is **no client-side expiry**. See `SESSION EXPIRY` below.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';

import {
  exchangeGoogleToken,
  setAuthFailureHandler,
  setAuthToken,
  type SessionUser,
} from '@/api';

// ── Configuration ─────────────────────────────────────────────────────────────
//
// THE CRUX OF THE WHOLE SIGN-IN DESIGN (MobileAppPlan.md §5).
//
// `back/routers/auth_router.py` verifies the Google ID token with
// `id_token.verify_oauth2_token(..., audience=GOOGLE_CLIENT_ID)` — a **single**
// audience, the *web* client ID. Configuring `webClientId` here makes the
// native sign-in mint its `idToken` for that same audience, so `POST
// /auth/login` accepts it unchanged.
//
// → Zero backend changes. `back/` is not touched by this project at all.
//
// The Android OAuth client (package name + signing SHA-1) still has to exist in
// the same GCP project or Google refuses the handshake, but that client ID is
// never referenced in code — its only job is to authorise it. Do not add one
// here; there is nothing to add it to.

const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

if (!WEB_CLIENT_ID) {
  // Same posture as `api.ts`: fail loudly at import rather than turning a
  // missing build-time variable into an inscrutable sign-in failure on device.
  console.error(
    'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is not set. Sign-in cannot work. ' +
      'Set it in .env (local) or as an EAS build env var — see .env.example.'
  );
}

// Synchronous and side-effect-only, so module scope is the right place: it must
// have run before any screen can reach a sign-in button.
GoogleSignin.configure({
  webClientId: WEB_CLIENT_ID,
  // email + profile are the defaults and are all `/auth/login` needs.
});

// ── Storage ───────────────────────────────────────────────────────────────────
//
// SESSION EXPIRY — why there is no `session_exp` key here.
//
// `front/src/auth.tsx` stores `Date.now() + 7 days` under `session_exp` and
// treats a stored session as dead once that passes. That number is the web
// app's own constant, not the JWT's `exp` claim — if the server's
// `SESSION_EXPIRY_DAYS` ever changes, the two disagree silently and the client
// is wrong in one direction or the other.
//
// The server is the authority on whether a token is still good, and it answers
// on every single request. So: store the token, send it, and let the server
// say. A lapsed session comes back as a 401/403 and is handled by `recover()`
// below. Simpler, and strictly more correct.

const TOKEN_KEY = 'session_token';
const USER_KEY = 'session_user';

async function readStoredSession(): Promise<{ token: string; user: SessionUser } | null> {
  try {
    const [token, userRaw] = await Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY),
      SecureStore.getItemAsync(USER_KEY),
    ]);
    if (!token || !userRaw) return null;
    return { token, user: JSON.parse(userRaw) as SessionUser };
  } catch {
    // A corrupt or unreadable keystore entry is indistinguishable from no
    // session, and is recovered from the same way: sign in again.
    return null;
  }
}

async function writeStoredSession(token: string, user: SessionUser): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

async function clearStoredSession(): Promise<void> {
  // Deleting a key that is not there is not an error worth propagating; the
  // caller is already on its way to the sign-in screen.
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined),
    SecureStore.deleteItemAsync(USER_KEY).catch(() => undefined),
  ]);
}

// ── Context ───────────────────────────────────────────────────────────────────

/**
 * `restoring` is the boot read of SecureStore. It exists so `app/index.tsx` can
 * hold a spinner instead of flashing the sign-in screen at a signed-in user.
 */
export type AuthStatus = 'restoring' | 'signed-in' | 'signed-out';

export interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  isSignedIn: boolean;
  /**
   * Runs the Google flow and exchanges the resulting ID token for a session.
   *
   * Resolves `'cancelled'` when the user backs out — that is a no-op, not an
   * error, and callers must not show it as one. Anything genuinely wrong
   * throws; run it through `apiErrorMessage()` for display.
   */
  signIn: () => Promise<'signed-in' | 'cancelled'>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [user, setUser] = useState<SessionUser | null>(null);

  const adopt = useCallback(async (token: string, nextUser: SessionUser) => {
    await writeStoredSession(token, nextUser);
    setAuthToken(token);
    setUser(nextUser);
    setStatus('signed-in');
  }, []);

  const abandon = useCallback(async () => {
    await clearStoredSession();
    setAuthToken(null);
    setUser(null);
    setStatus('signed-out');
  }, []);

  // ── Boot ────────────────────────────────────────────────────────────────────
  // Read the keystore, prime `api.ts`, then release the UI. Nothing renders a
  // route decision until this settles.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const stored = await readStoredSession();
      if (cancelled) return;

      if (stored) {
        setAuthToken(stored.token);
        setUser(stored.user);
        setStatus('signed-in');
      } else {
        setAuthToken(null);
        setStatus('signed-out');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Expired sessions ────────────────────────────────────────────────────────
  //
  // The response interceptor in `api.ts` has already dropped the in-memory
  // token by the time this runs (401 = missing, 403 = expired or invalid —
  // `back/auth.py` uses both). The JWT lasts 7 days and there is no refresh
  // endpoint, so the only recovery available is a silent Google re-sign-in and
  // a fresh exchange. One attempt; failing that, the sign-in screen.
  //
  // `recovery` holds the in-flight attempt rather than a boolean flag, so that
  // concurrent callers **share one recovery and each get its result**. A screen
  // firing three requests in parallel gets three 401s; a boolean guard would
  // let the first recover and silently drop the other two, which is what a
  // returned promise avoids. `api.ts` awaits this and replays the request that
  // failed, so a lapsed session costs the user nothing.
  const recovery = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    setAuthFailureHandler(() => {
      if (recovery.current) return recovery.current;

      const attempt = (async (): Promise<boolean> => {
        try {
          const res = await GoogleSignin.signInSilently();
          const idToken = res.type === 'success' ? res.data.idToken : null;
          if (!idToken) throw new Error('No saved Google credential.');

          const { session_token, user: nextUser } = await exchangeGoogleToken(idToken);
          await adopt(session_token, nextUser);
          return true;
        } catch {
          await abandon();
          // The tab group also guards itself (`app/(tabs)/_layout.tsx`), which
          // covers the common case declaratively. This is the belt for any
          // route outside that group.
          router.replace('/sign-in');
          return false;
        } finally {
          // Cleared before the promise settles for its callers, so a later
          // failure starts a fresh attempt rather than reusing this result.
          recovery.current = null;
        }
      })();

      recovery.current = attempt;
      return attempt;
    });

    return () => setAuthFailureHandler(null);
  }, [adopt, abandon]);

  // ── Sign in / out ───────────────────────────────────────────────────────────

  const signIn = useCallback(async (): Promise<'signed-in' | 'cancelled'> => {
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

      const res = await GoogleSignin.signIn();
      // v16 reports a user-cancelled flow as a response, not a rejection.
      if (res.type !== 'success') return 'cancelled';

      const idToken = res.data.idToken;
      if (!idToken) {
        throw new Error(
          'Google returned no ID token. Check that EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ' +
            'is the web client ID.'
        );
      }

      const { session_token, user: nextUser } = await exchangeGoogleToken(idToken);
      await adopt(session_token, nextUser);
      return 'signed-in';
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;

      // Two non-errors wearing an error's clothes:
      //   SIGN_IN_CANCELLED — some library paths still *throw* the cancellation
      //     rather than returning the `'cancelled'` response above.
      //   IN_PROGRESS — a second tap landed on a flow already running. The
      //     button's loading state normally prevents it; if it slips through,
      //     the right answer is silence, not a scary red note.
      if (code === statusCodes.SIGN_IN_CANCELLED || code === statusCodes.IN_PROGRESS) {
        return 'cancelled';
      }

      // The native message for this one is not something to show a person.
      if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        throw new Error('Google Play services is missing or out of date on this device.');
      }

      throw error;
    }
  }, [adopt]);

  const signOut = useCallback(async () => {
    // Clearing Google's own session is best-effort: if it fails, ours must
    // still go, or the user is stuck signed in to an app they asked to leave.
    await GoogleSignin.signOut().catch(() => undefined);
    await abandon();
  }, [abandon]);

  return (
    <AuthContext.Provider
      value={{ status, user, isSignedIn: status === 'signed-in', signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
