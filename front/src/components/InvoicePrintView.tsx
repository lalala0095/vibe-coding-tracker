import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getInvoice } from '../api';
import { formatMoney, roundHours } from '../lib/money';
import type { Invoice, InvoiceStatus } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
//
// Money formatting lives in ../lib/money so the print view, the builder and the
// backend all agree. Nothing in this file does arithmetic: every figure shown
// is a stored value off the invoice document.
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Render a "YYYY-MM-DD" string as "3 Jul 2026".
 *
 * Parsed by hand rather than through `new Date()`, which reads a bare date as
 * UTC and can shift it by a day depending on the viewer's timezone. Anything
 * that is not a well-formed date string is passed through untouched.
 */
function formatDate(value: string | null): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return value;
  return `${Number(day)} ${monthName} ${year}`;
}

/**
 * Render a date range, collapsing to a single date when both ends match or only
 * one end is present. Returns an empty string when neither end is set — callers
 * decide whether that means "omit the block" or "show a placeholder".
 */
function formatDateRange(from: string | null, to: string | null): string {
  if (!from && !to) return '';
  if (!to || from === to) return formatDate(from);
  if (!from) return formatDate(to);
  return `${formatDate(from)} – ${formatDate(to)}`;
}

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: 'border-slate-400 text-slate-600',
  sent: 'border-blue-500 text-blue-700',
  paid: 'border-emerald-500 text-emerald-700',
  void: 'border-red-400 text-red-600',
};

// ─────────────────────────────────────────────────────────────────────────────
// The document
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A print-ready A4 invoice document.
 *
 * Renders the invoice exactly as stored. `amount`, `subtotal`, `discount_amount`,
 * `tax_amount` and `total` are server-computed and snapshotted, as are `bill_to`
 * and `issued_by` — none of them are recomputed or re-resolved here, so a
 * historical invoice always prints the figures it was saved with.
 *
 * The sheet is deliberately light-on-white on screen as well as on paper, so the
 * preview inside the dark app shell matches what actually comes out of the
 * printer.
 */
export function InvoicePrintView({ invoice }: { invoice: Invoice }) {
  const { currency } = invoice;
  const hasDiscount = invoice.discount_amount !== 0;
  const hasTax = invoice.tax_percent !== 0 || invoice.tax_amount !== 0;

  const discountLabel =
    invoice.discount_type === 'percent'
      ? `Discount (${invoice.discount_value}%)`
      : 'Discount';

  // tax_label can be null even on a taxed invoice — never print "null".
  const taxLabel = `${invoice.tax_label || 'Tax'} (${invoice.tax_percent}%)`;

  // Empty when the invoice carries no period at all; the block is dropped rather
  // than printed blank.
  const periodLabel = formatDateRange(invoice.period_start, invoice.period_end);

  // Print-only switches. `!== false` rather than a truthy test so an invoice
  // created before the fields existed keeps printing both blocks, as it did.
  // A row with nothing to show is dropped regardless of the switch.
  const showDueDate = invoice.show_due_date !== false && Boolean(invoice.due_date);
  const showPaymentTerms =
    invoice.show_payment_terms !== false && Boolean(invoice.payment_terms);

  return (
    <article className="invoice-sheet mx-auto w-full max-w-[210mm] bg-white p-10 text-slate-900 shadow-2xl print:shadow-none">
      {/* Header ------------------------------------------------------------ */}
      <header className="invoice-break-avoid flex items-start justify-between gap-8">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {invoice.issued_by.business_name}
          </h1>
          {/* Snapshotted like everything else in this block, and absent on
              invoices created before the field existed. */}
          {invoice.issued_by.contact_name && (
            <p className="mt-0.5 text-sm font-medium text-slate-700">
              {invoice.issued_by.contact_name}
            </p>
          )}
          {invoice.issued_by.address && (
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-600">
              {invoice.issued_by.address}
            </p>
          )}
          {invoice.issued_by.email && (
            <p className="mt-1 text-sm text-slate-600">{invoice.issued_by.email}</p>
          )}
        </div>

        <div className="shrink-0 text-right">
          <p className="text-2xl font-bold uppercase tracking-[0.2em] text-slate-400">
            Invoice
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900">
            {invoice.invoice_number}
          </p>
          <span
            className={`mt-2 inline-block rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${STATUS_STYLES[invoice.status]}`}
          >
            {invoice.status}
          </span>
        </div>
      </header>

      <div className="my-6 border-t border-slate-300" />

      {/* Bill-to and meta --------------------------------------------------- */}
      <section className="invoice-break-avoid flex items-start justify-between gap-8">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Bill To
          </h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-800">
            {invoice.bill_to || invoice.client_name}
          </p>
        </div>

        {/* A two-column grid, not a fixed-width column: a period reading
            "1 Jul 2026 – 31 Jul 2026" is far wider than a single date, and the
            old w-32 value column forced it onto a second line. The grid sizes
            itself to the widest value and nowrap keeps every row on one line. */}
        <dl className="grid shrink-0 grid-cols-[auto_auto] gap-x-6 gap-y-1 text-sm">
          <dt className="whitespace-nowrap text-slate-500">Issue date</dt>
          <dd className="whitespace-nowrap text-right font-medium text-slate-900">
            {formatDate(invoice.issue_date)}
          </dd>

          {showDueDate && (
            <>
              <dt className="whitespace-nowrap text-slate-500">Due date</dt>
              <dd className="whitespace-nowrap text-right font-medium text-slate-900">
                {formatDate(invoice.due_date)}
              </dd>
            </>
          )}

          {periodLabel && (
            <>
              <dt className="whitespace-nowrap text-slate-500">Period</dt>
              <dd className="whitespace-nowrap text-right font-medium text-slate-900">
                {periodLabel}
              </dd>
            </>
          )}
        </dl>
      </section>

      {/* Lines -------------------------------------------------------------- */}
      <table className="mt-8 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-slate-300 text-left">
            <th className="py-2 pr-4 font-semibold text-slate-700">Description</th>
            <th className="py-2 pr-4 font-semibold text-slate-700">Dates worked</th>
            <th className="py-2 pr-4 text-right font-semibold text-slate-700">Hours</th>
            <th className="py-2 pr-4 text-right font-semibold text-slate-700">Rate</th>
            <th className="py-2 text-right font-semibold text-slate-700">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.length === 0 && (
            <tr className="border-b border-slate-200">
              <td colSpan={5} className="py-4 text-center text-slate-500">
                No lines on this invoice.
              </td>
            </tr>
          )}

          {invoice.lines.map((line) => {
            // Tracker-billed lines carry the tracker's task titles. Read
            // defensively and drop blanks: invoices stored before the field
            // existed have none, and the editor allows an empty bullet.
            const subItems = (line.sub_items ?? []).filter((item) => item.trim());

            return (
              <tr key={line.line_id} className="border-b border-slate-200 align-top">
                <td className="py-2 pr-4 text-slate-900">
                  {line.description || line.task_title}
                  {line.project_name && (
                    <span className="block text-xs text-slate-500">
                      {line.project_name}
                    </span>
                  )}
                  {subItems.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs leading-snug text-slate-600">
                      {subItems.map((item, index) => (
                        // Titles are free text and can repeat, so the index is the
                        // only stable key. The list is render-only, never reordered.
                        <li key={index} className="break-words">
                          {item}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-2 pr-4 whitespace-nowrap text-slate-700">
                  {formatDateRange(line.date_from, line.date_to) || '—'}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-slate-900">
                  {roundHours(line.hours).toFixed(2)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-slate-900">
                  {formatMoney(line.rate, currency)}
                </td>
                <td className="py-2 text-right tabular-nums font-medium text-slate-900">
                  {formatMoney(line.amount, currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Totals ------------------------------------------------------------- */}
      <section className="invoice-break-avoid mt-6 flex justify-end">
        <dl className="w-full max-w-xs space-y-1 text-sm">
          <div className="flex justify-between gap-6">
            <dt className="text-slate-600">Subtotal</dt>
            <dd className="tabular-nums text-slate-900">
              {formatMoney(invoice.subtotal, currency)}
            </dd>
          </div>

          {hasDiscount && (
            <div className="flex justify-between gap-6">
              <dt className="text-slate-600">{discountLabel}</dt>
              <dd className="tabular-nums text-slate-900">
                −{formatMoney(invoice.discount_amount, currency)}
              </dd>
            </div>
          )}

          {hasTax && (
            <div className="flex justify-between gap-6">
              <dt className="text-slate-600">{taxLabel}</dt>
              <dd className="tabular-nums text-slate-900">
                {formatMoney(invoice.tax_amount, currency)}
              </dd>
            </div>
          )}

          <div className="flex justify-between gap-6 border-t-2 border-slate-300 pt-2 text-base font-bold">
            <dt className="text-slate-900">Total</dt>
            <dd className="tabular-nums text-slate-900">
              {formatMoney(invoice.total, currency)}
            </dd>
          </div>
        </dl>
      </section>

      {/* Footer ------------------------------------------------------------- */}
      {(showPaymentTerms || invoice.notes) && (
        <footer className="invoice-break-avoid mt-10 border-t border-slate-300 pt-4 text-sm">
          {showPaymentTerms && (
            <div className="mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Payment terms
              </h3>
              <p className="mt-1 text-slate-800">{invoice.payment_terms}</p>
            </div>
          )}
          {invoice.notes && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Notes
              </h3>
              <p className="mt-1 whitespace-pre-line leading-relaxed text-slate-800">
                {invoice.notes}
              </p>
            </div>
          )}
        </footer>
      )}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Route wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route component for ``/invoices/:id/print``.
 *
 * Fetches the invoice and renders the document inside minimal on-screen chrome.
 * Everything outside the sheet is marked ``print:hidden`` so only the document
 * reaches the page.
 */
export default function InvoicePrintPage() {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInvoice = useCallback(async () => {
    if (!id) {
      setError('No invoice specified.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setInvoice(await getInvoice(id));
    } catch {
      setError('Could not load that invoice.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadInvoice();
  }, [loadInvoice]);

  return (
    <div className="min-h-screen bg-slate-950 py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-6 flex w-full max-w-[210mm] items-center justify-between px-4 print:hidden">
        <Link
          to="/invoices"
          className="text-sm text-slate-400 transition-colors hover:text-slate-200"
        >
          ← Back to invoices
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          disabled={!invoice}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Print
        </button>
      </div>

      {loading && (
        <p className="text-center text-slate-400 print:hidden">Loading invoice…</p>
      )}

      {error && !loading && (
        <p className="text-center text-red-400 print:hidden">{error}</p>
      )}

      {invoice && !loading && <InvoicePrintView invoice={invoice} />}
    </div>
  );
}
