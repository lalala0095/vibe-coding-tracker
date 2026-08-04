import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { InvoiceSettings, UpdateInvoiceSettingsPayload } from '../types';
import { getInvoiceSettings, updateInvoiceSettings } from '../api';
import AppNav from '../components/AppNav';

const FIELD =
  'w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm ' +
  'placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';

const LABEL = 'text-xs text-slate-400 mb-1 block';

// Local form shape: every field a string or boolean so inputs stay controlled
// while being typed. Converted back to the wire types on save.
interface FormState {
  business_name: string;
  contact_name: string;
  address: string;
  email: string;
  logo_url: string;
  default_currency: string;
  default_payment_terms: string;
  default_due_days: string;
  default_tax_label: string;
  default_tax_percent: string;
  default_rate: string;
  invoice_prefix: string;
  reset_sequence_yearly: boolean;
}

function toForm(s: InvoiceSettings): FormState {
  return {
    business_name: s.business_name ?? '',
    contact_name: s.contact_name ?? '',
    address: s.address ?? '',
    email: s.email ?? '',
    logo_url: s.logo_url ?? '',
    default_currency: s.default_currency ?? 'USD',
    default_payment_terms: s.default_payment_terms ?? '',
    default_due_days: String(s.default_due_days ?? 14),
    default_tax_label: s.default_tax_label ?? '',
    default_tax_percent: String(s.default_tax_percent ?? 0),
    default_rate: String(s.default_rate ?? 0),
    invoice_prefix: s.invoice_prefix ?? 'INV',
    reset_sequence_yearly: s.reset_sequence_yearly ?? true,
  };
}

function num(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function InvoiceSettingsPage() {
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setForm(toForm(await getInvoiceSettings()));
    } catch {
      setError('Failed to load invoice settings.');
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
      const payload: UpdateInvoiceSettingsPayload = {
        business_name: form.business_name,
        contact_name: form.contact_name,
        address: form.address,
        email: form.email,
        // logo_url is a string field, so the repo's "null" sentinel clears it.
        logo_url: form.logo_url.trim() === '' ? 'null' : form.logo_url.trim(),
        default_currency: form.default_currency,
        default_payment_terms: form.default_payment_terms,
        default_due_days: num(form.default_due_days),
        default_tax_label: form.default_tax_label,
        default_tax_percent: num(form.default_tax_percent),
        default_rate: num(form.default_rate),
        invoice_prefix: form.invoice_prefix,
        reset_sequence_yearly: form.reset_sequence_yearly,
      };
      setForm(toForm(await updateInvoiceSettings(payload)));
      setSaved(true);
    } catch {
      setError('Failed to save invoice settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AppNav active="invoices" />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-2 text-sm text-slate-500 mb-3">
            <Link to="/invoices" className="hover:text-slate-300 transition-colors">
              Invoices
            </Link>
            <span>/</span>
            <span className="text-slate-300">Settings</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100">Invoice Settings</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Business details and the defaults applied to a new invoice. Each invoice snapshots
            these at creation, so changes here never rewrite an existing invoice.
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
            {/* ── Business details ── */}
            <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-slate-100 mb-4">Business details</h2>
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className={LABEL}>Business name</label>
                    <input
                      type="text"
                      value={form.business_name}
                      onChange={(e) => set({ business_name: e.target.value })}
                      placeholder="Your business"
                      className={FIELD}
                    />
                  </div>
                  <div>
                    <label className={LABEL}>
                      Your name <span className="text-slate-600">(printed under the business name)</span>
                    </label>
                    <input
                      type="text"
                      value={form.contact_name}
                      onChange={(e) => set({ contact_name: e.target.value })}
                      placeholder="Jane Tan"
                      className={FIELD}
                    />
                  </div>
                  <div>
                    <label className={LABEL}>Email</label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => set({ email: e.target.value })}
                      placeholder="billing@example.com"
                      className={FIELD}
                    />
                  </div>
                </div>
                <div>
                  <label className={LABEL}>Address</label>
                  <textarea
                    rows={3}
                    value={form.address}
                    onChange={(e) => set({ address: e.target.value })}
                    placeholder={'123 Example Rd\nSingapore 123456'}
                    className={`${FIELD} resize-none`}
                  />
                </div>
                <div>
                  <label className={LABEL}>
                    Logo URL <span className="text-slate-600">(leave empty to clear)</span>
                  </label>
                  <input
                    type="url"
                    value={form.logo_url}
                    onChange={(e) => set({ logo_url: e.target.value })}
                    placeholder="https://…"
                    className={FIELD}
                  />
                </div>
              </div>
            </section>

            {/* ── Invoice defaults ── */}
            <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-slate-100 mb-4">Defaults for new invoices</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className={LABEL}>Currency</label>
                  <input
                    type="text"
                    value={form.default_currency}
                    onChange={(e) => set({ default_currency: e.target.value })}
                    placeholder="USD"
                    className={FIELD}
                  />
                </div>
                <div>
                  <label className={LABEL}>Default rate</label>
                  <input
                    type="number"
                    step="0.01"
                    value={form.default_rate}
                    onChange={(e) => set({ default_rate: e.target.value })}
                    className={FIELD}
                  />
                </div>
                <div>
                  <label className={LABEL}>Due days</label>
                  <input
                    type="number"
                    step="1"
                    value={form.default_due_days}
                    onChange={(e) => set({ default_due_days: e.target.value })}
                    className={FIELD}
                  />
                </div>
                <div>
                  <label className={LABEL}>Payment terms</label>
                  <input
                    type="text"
                    value={form.default_payment_terms}
                    onChange={(e) => set({ default_payment_terms: e.target.value })}
                    placeholder="Net 14"
                    className={FIELD}
                  />
                </div>
                <div>
                  <label className={LABEL}>Tax label</label>
                  <input
                    type="text"
                    value={form.default_tax_label}
                    onChange={(e) => set({ default_tax_label: e.target.value })}
                    placeholder="GST"
                    className={FIELD}
                  />
                </div>
                <div>
                  <label className={LABEL}>Tax percent</label>
                  <input
                    type="number"
                    step="0.01"
                    value={form.default_tax_percent}
                    onChange={(e) => set({ default_tax_percent: e.target.value })}
                    className={FIELD}
                  />
                </div>
              </div>
            </section>

            {/* ── Numbering ── */}
            <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-slate-100 mb-4">Numbering</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
                <div>
                  <label className={LABEL}>Invoice prefix</label>
                  <input
                    type="text"
                    value={form.invoice_prefix}
                    onChange={(e) => set({ invoice_prefix: e.target.value })}
                    placeholder="INV"
                    className={FIELD}
                  />
                  <p className="text-xs text-slate-500 mt-1.5">
                    Numbers are shaped{' '}
                    <span className="text-slate-400">
                      {(form.invoice_prefix || 'INV')}-{new Date().getFullYear()}-013
                    </span>
                    .
                  </p>
                </div>
                <label className="flex items-center gap-2.5 cursor-pointer sm:mt-6">
                  <input
                    type="checkbox"
                    checked={form.reset_sequence_yearly}
                    onChange={(e) => set({ reset_sequence_yearly: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-0"
                  />
                  <span className="text-sm text-slate-300">Restart the sequence each year</span>
                </label>
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
