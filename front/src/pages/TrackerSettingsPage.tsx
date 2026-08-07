import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import type { TrackerSettings, UpdateTrackerSettingsPayload } from '../types';
import { getTrackerSettings, updateTrackerSettings } from '../api';
import {
  TRACKER_NAME_TOKENS, previewTrackerName, unknownTokens,
} from '../lib/trackerName';
import AppNav from '../components/AppNav';

const FIELD =
  'w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm ' +
  'placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';

const LABEL = 'text-xs text-slate-400 mb-1 block';

// The server rejects a template naming a token it does not know, and its
// `detail` says which one. That message is the most useful thing this page can
// show, so it is surfaced verbatim rather than replaced with a generic failure.
function errorDetail(e: unknown, fallback: string): string {
  if (axios.isAxiosError(e)) {
    const data: unknown = e.response?.data;
    if (data && typeof data === 'object' && 'detail' in data) {
      const detail = (data as { detail: unknown }).detail;
      if (typeof detail === 'string' && detail.trim()) return detail;
    }
  }
  return fallback;
}

// Local form shape, kept as plain strings/booleans so the template input stays
// controlled while a half-typed `{dat` sits in it.
interface FormState {
  auto_name_enabled: boolean;
  auto_name_template: string;
}

function toForm(s: TrackerSettings): FormState {
  return {
    auto_name_enabled: s.auto_name_enabled ?? true,
    auto_name_template: s.auto_name_template ?? '',
  };
}

export default function TrackerSettingsPage() {
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setForm(toForm(await getTrackerSettings()));
    } catch {
      setError('Failed to load tracker settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const set = (changes: Partial<FormState>) => {
    setForm((prev) => (prev ? { ...prev, ...changes } : prev));
    setSaved(false);
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    setError('');
    try {
      const payload: UpdateTrackerSettingsPayload = {
        auto_name_enabled: form.auto_name_enabled,
        auto_name_template: form.auto_name_template,
      };
      setForm(toForm(await updateTrackerSettings(payload)));
      setSaved(true);
    } catch (e) {
      setError(errorDetail(e, 'Failed to save tracker settings.'));
    } finally {
      setSaving(false);
    }
  };

  // Recomputed every render, so both the preview and the token examples follow
  // the template as it is typed rather than showing the moment the page loaded.
  const now = new Date();
  const preview = form ? previewTrackerName(form.auto_name_template, now) : '';
  const unknown = form ? unknownTokens(form.auto_name_template) : [];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AppNav active="trackers" />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-2 text-sm text-slate-500 mb-3">
            <Link to="/trackers" className="hover:text-slate-300 transition-colors">
              Trackers
            </Link>
            <span>/</span>
            <span className="text-slate-300">Settings</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100">Tracker settings</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            What a new tracker's title is pre-filled with. It is only a starting point — the
            title stays editable from the moment the form opens.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
            Loading settings…
          </div>
        ) : !form ? (
          <div className="flex items-center gap-3 py-4">
            <p className="text-sm text-red-400">{error || 'Settings unavailable.'}</p>
            <button
              onClick={fetchSettings}
              className="text-xs text-violet-400 hover:text-violet-300 underline transition-colors"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* ── Auto-naming ── */}
            <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-slate-100 mb-4">Automatic title</h2>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.auto_name_enabled}
                  onChange={(e) => set({ auto_name_enabled: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-0"
                />
                <span className="text-sm text-slate-300">Pre-fill the title of a new tracker</span>
              </label>
              <p className="text-xs text-slate-500 mt-1.5 ml-7">
                Off leaves the title blank, to be typed each time.
              </p>

              {/* Dimmed, never disabled, when the pre-fill is off — the template
                  is still worth editing before switching it back on. */}
              <div
                className={`mt-5 transition-opacity ${form.auto_name_enabled ? '' : 'opacity-50'}`}
              >
                <label className={LABEL}>Title template</label>
                <input
                  type="text"
                  value={form.auto_name_template}
                  onChange={(e) => set({ auto_name_template: e.target.value })}
                  placeholder="{date} tasks"
                  className={`${FIELD} font-mono`}
                />

                {/* The server refuses to store an unknown token, so this says
                    the save will be rejected rather than that the token will
                    print literally — it never gets the chance to. Warning early
                    only helps if it describes what actually happens next. */}
                {unknown.length > 0 && (
                  <p className="text-xs text-amber-400 mt-2">
                    {unknown.map((name) => `{${name}}`).join(', ')}{' '}
                    {unknown.length === 1 ? 'is not a token' : 'are not tokens'}. Saving will be
                    rejected until {unknown.length === 1 ? 'it is' : 'they are'} corrected or the
                    braces are removed.
                  </p>
                )}

                <div className="mt-4">
                  <div className={LABEL}>A tracker started now would be called</div>
                  <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5">
                    {preview ? (
                      <span className="font-mono text-sm text-slate-100 break-all">{preview}</span>
                    ) : (
                      <span className="text-sm text-slate-500 italic">
                        Nothing — the title would be left blank.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* ── Token reference ── */}
            <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-slate-100 mb-1">Tokens</h2>
              <p className="text-xs text-slate-500 mb-4">
                Click one to add it to the end of the template. Anything else in the template is
                printed as-is.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {TRACKER_NAME_TOKENS.map((token) => (
                  <button
                    key={token.token}
                    type="button"
                    onClick={() =>
                      set({ auto_name_template: `${form.auto_name_template}{${token.token}}` })
                    }
                    className="text-left bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2
                               hover:bg-slate-800 hover:border-violet-600 transition-colors"
                  >
                    <div className="font-mono text-xs text-violet-400">{`{${token.token}}`}</div>
                    <div className="text-xs text-slate-400 mt-1">{token.label}</div>
                    <div className="font-mono text-xs text-slate-300 mt-0.5 truncate">
                      {token.render(now)}
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {error && (
              <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-3">
              {saved && <span className="text-xs text-green-400">Saved.</span>}
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg
                           hover:bg-violet-500 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {saving && (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                )}
                Save settings
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
