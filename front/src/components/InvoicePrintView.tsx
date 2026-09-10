import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getInvoice } from '../api';
import { formatHours, formatMoney, roundHours } from '../lib/money';
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

/**
 * Whether the status badge belongs on the document at all.
 *
 * `draft` does not. This route *is* the thing that gets printed and handed to
 * a client, and "DRAFT" stamped across the top of it says the invoice is not
 * real yet — which is either wrong or, worse, a reason for the client not to
 * pay it. Draft is an internal state of the editor and it stays there.
 *
 * The other three earn their place on paper: PAID and VOID change what the
 * reader should do about the document, and SENT records that it was issued.
 * Nothing about the badge is load-bearing for the figures either way.
 */
function showsStatus(status: InvoiceStatus): boolean {
  return status !== 'draft';
}

// ─────────────────────────────────────────────────────────────────────────────
// The document
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A print-ready A4 invoice document.
 *
 * Renders the invoice exactly as stored. `amount`, `subtotal`, `total_hours`,
 * `discount_amount`, `tax_amount` and `total` are server-computed and
 * snapshotted, as are `bill_to` and `issued_by` — none of them are recomputed or
 * re-resolved here, so a historical invoice always prints the figures it was
 * saved with.
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
          {showsStatus(invoice.status) && (
            <span
              className={`mt-2 inline-block rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${STATUS_STYLES[invoice.status]}`}
            >
              {invoice.status}
            </span>
          )}
        </div>
      </header>

      <div className="my-6 border-t border-slate-300" />

      {/* Summary ------------------------------------------------------------
          The three figures a client looks for first, before the detail. Every
          one is the invoice's STORED value printed verbatim — the same numbers
          the totals block at the foot of the page shows, read from the same
          fields, not recomputed here (see the header comment). Nothing in this
          band can therefore disagree with the bottom of the document.

          Labelled "Total", not "Amount due". This view never prints payments —
          `PaymentsPanel` states the rule outright: what reached the owner's
          bank after FX is internal. So the document has no idea whether any of
          this has been settled, and a band promising "amount due" would state
          the full figure to a client who had already paid half of it. "Total"
          is what the invoice bills, which is true whatever has been paid.

          The background survives printing: `.invoice-sheet *` already carries
          `print-color-adjust: exact` in index.css, which is there precisely so
          fills like this one are not dropped by the browser. */}
      <section className="invoice-break-avoid mb-6 rounded border border-slate-300 bg-slate-50 px-5 py-4">
        <dl className="flex flex-wrap items-baseline justify-between gap-x-10 gap-y-4">
          <div className="min-w-0">
            <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Total
            </dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
              {formatMoney(invoice.total, currency)}
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Total hours
            </dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
              {formatHours(invoice.total_hours)}
            </dd>
          </div>

          {/* Dropped rather than shown empty: an invoice raised with no period
              is legitimate, and an unlabelled dash reads like missing data. */}
          {periodLabel && (
            <div className="min-w-0">
              <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Period
              </dt>
              <dd className="mt-1 whitespace-nowrap text-sm font-medium text-slate-900">
                {periodLabel}
              </dd>
            </div>
          )}
        </dl>
      </section>

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
          {/* The stored figure, printed verbatim like every other total here.
              Not summed off `invoice.lines` and not passed through
              `computeMoney`: the server resolves it on write, including for
              invoices saved before the field existed, so a historical invoice
              prints the hours it was saved with. `formatHours` only formats. */}
          <div className="flex justify-between gap-6">
            <dt className="text-slate-600">Total hours</dt>
            <dd className="tabular-nums text-slate-700">
              {formatHours(invoice.total_hours)}
            </dd>
          </div>

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
