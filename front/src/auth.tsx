import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export interface GoogleUser {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

interface AuthState {
  sessionToken: string | null;
  user: GoogleUser | null;
}

interface AuthContextValue extends AuthState {
  login: (sessionToken: string, user: GoogleUser) => void;
  logout: () => void;
}

const TOKEN_KEY = 'session_token';
const USER_KEY  = 'session_user';
const EXP_KEY   = 'session_exp';

const SESSION_DAYS = 7;

function loadInitialState(): AuthState {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const userRaw = localStorage.getItem(USER_KEY);
    const exp = Number(localStorage.getItem(EXP_KEY) ?? '0');

    if (token && userRaw && exp > Date.now()) {
      return { sessionToken: token, user: JSON.parse(userRaw) };
    }
  } catch { /* ignore */ }

  // Clear any stale data
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(EXP_KEY);
  return { sessionToken: null, user: null };
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(loadInitialState);

  const login = useCallback((sessionToken: string, user: GoogleUser) => {
    const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    localStorage.setItem(TOKEN_KEY, sessionToken);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem(EXP_KEY, String(exp));
    setState({ sessionToken, user });
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(EXP_KEY);
    setState({ sessionToken: null, user: null });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
