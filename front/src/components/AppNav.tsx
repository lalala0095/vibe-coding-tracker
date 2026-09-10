import { Link } from 'react-router-dom';
import { useAuth } from '../auth';

export type NavKey =
  | 'sessions' | 'tasks' | 'time' | 'trackers' | 'invoices' | 'models' | 'manage';

interface Props {
  active: NavKey;
  /** Full-width header container instead of the centred max-w-5xl one. */
  wide?: boolean;
}

const NAV_LINKS: { key: NavKey; to: string; label: string }[] = [
  { key: 'sessions', to: '/dashboard', label: 'Sessions' },
  { key: 'tasks',    to: '/tasks',     label: 'Tasks' },
  { key: 'time',     to: '/time',      label: 'Time Entries' },
  { key: 'trackers', to: '/trackers',  label: 'Trackers' },
  { key: 'invoices', to: '/invoices',  label: 'Invoices' },
  { key: 'models',   to: '/models',    label: 'Models' },
  { key: 'manage',   to: '/manage',    label: 'Clients & Projects' },
];

const ACTIVE_LINK =
  'px-3 py-1.5 text-sm text-slate-100 bg-slate-800 rounded-lg transition-colors font-medium';
const INACTIVE_LINK =
  'px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors';

export default function AppNav({ active, wide = false }: Props) {
  const { user, logout } = useAuth();

  return (
    <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-sm border-b border-slate-800 shrink-0">
      <div
        className={`${wide ? 'w-full' : 'max-w-5xl mx-auto'} px-4 sm:px-6 h-16 flex items-center justify-between gap-4`}
      >
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <Link
            to="/dashboard"
            className="flex items-center gap-3 hover:opacity-80 transition-opacity"
          >
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <span className="text-base font-semibold text-slate-100 hidden sm:block">
              Vibe Coding Tracker
            </span>
          </Link>
        </div>

        {/* Right: nav links + user */}
        <nav className="flex items-center gap-1">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.key}
              to={link.to}
              className={link.key === active ? ACTIVE_LINK : INACTIVE_LINK}
            >
              {link.label}
            </Link>
          ))}

          {user?.picture ? (
            <img
              src={user.picture}
              alt={user.name ?? 'User'}
              className="w-8 h-8 rounded-full border border-slate-700 ml-1"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs text-slate-300 ml-1">
              {user?.name?.[0] ?? user?.email?.[0] ?? '?'}
            </div>
          )}

          <button
            onClick={logout}
            className="px-3 py-1.5 text-sm text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors"
          >
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}
