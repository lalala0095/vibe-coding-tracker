import { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../auth';
import { useNavigate } from 'react-router-dom';
import { exchangeGoogleToken } from '../api';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          {/* Logo */}
          <div className="flex justify-center mb-6">
            <div
              className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600
                         flex items-center justify-center shadow-lg shadow-violet-500/25"
            >
              <svg
                className="w-8 h-8 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                />
              </svg>
            </div>
          </div>

          {/* Heading */}
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-slate-100 mb-2">Vibe Coding Tracker</h1>
            <p className="text-sm text-slate-400">Track your AI-assisted coding sessions</p>
          </div>

          {/* Google Sign-In */}
          <div className="flex flex-col items-center gap-3">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
                <span className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                Signing in…
              </div>
            ) : (
              <GoogleLogin
                onSuccess={async (response) => {
                  if (!response.credential) return;
                  setError('');
                  setLoading(true);
                  try {
                    const { session_token, user } = await exchangeGoogleToken(response.credential);
                    login(session_token, user);
                    navigate('/dashboard');
                  } catch {
                    setError('Sign-in failed. Please try again.');
                    setLoading(false);
                  }
                }}
                onError={() => setError('Google Sign-In failed. Please try again.')}
                theme="filled_black"
                shape="rectangular"
                size="large"
                text="signin_with"
                logo_alignment="left"
              />
            )}

            {error && (
              <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2 text-center w-full">
                {error}
              </p>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">
          Personal use only · Your data stays yours
        </p>
      </div>
    </div>
  );
}
