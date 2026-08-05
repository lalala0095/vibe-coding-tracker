import { useState } from 'react';
import type { InvoiceLine, HoursRoundingDirection } from '../types';
import { computeMoney, formatMoney, type DiscountType } from '../lib/money';
import RoundHoursModal from './RoundHoursModal';

interface Props {
  lines: InvoiceLine[];
  currency: string;
  discountType: DiscountType;
  discountValue: number;
  taxLabel: string;
  taxPercent: number;
  onChange: (lines: InvoiceLine[]) => void;
  // ── Selection (builder only) ────────────────────────────────────────────────
  // All optional: the edit surface passes none of them and gets exactly the
  // table it has today, same column count included.
  excludedIds?: Set<string>;
  onToggleExclude?: (lineId: string) => void;
  // A per-line caveat from the parent — e.g. "this tracker's time entries are
  // already listed above". Rendered as a note; it never blocks anything.
  reasonForLine?: (lineId: string) => string | null;
  // ── Hours rounding defaults (from Invoice Settings) ─────────────────────────
  // Optional: the button is offered either way, so a surface that has not
  // loaded settings yet still gets the feature, just with a plain default.
  roundingIncrement?: number;
  roundingDirection?: HoursRoundingDirection;
}

// Used when the caller has no setting to hand. A quarter hour is the increment
// the Hours cell already steps by, so it is the least surprising fallback.
const FALLBACK_INCREMENT = 0.25;

const CELL_INPUT =
  'w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-2 py-1.5 text-sm ' +
  'placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';

// Sub-items are detail under the description, not headings of their own, so
// they read a size down and a shade dimmer than CELL_INPUT.
const SUB_INPUT =
  'flex-1 min-w-0 bg-slate-800 border border-slate-700 text-slate-300 rounded px-1.5 py-0.5 text-xs ' +
  'placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-transparent';

function todaySGT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

function newLine(): InvoiceLine {
  const today = todaySGT();
  return {
    line_id: crypto.randomUUID(),
    task_id: null,          // a manually added line has no task…
    task_title: '',
    project_id: null,
    project_name: '',
    description: '',
    date_from: today,
    date_to: today,
    hours: 0,
    rate: 0,
    amount: 0,
    session_ids: [],        // …and no time-entry provenance
    tracker_id: null,       // …and no tracker behind it
    sub_items: [],          // but it may still be given a task list by hand
  };
}

// ── Editable invoice lines + live totals ──────────────────────────────────────
// Nothing here is ever disabled or read-only, whatever the invoice's status
// (InvoicingPlan §1). `amount` is derived, so it renders as text rather than as
// a disabled input.

export default function InvoiceLineTable({
  lines, currency, discountType, discountValue, taxLabel, taxPercent, onChange,
  excludedIds, onToggleExclude, reasonForLine,
  roundingIncrement, roundingDirection,
}: Props) {
  // Raw text for numeric cells while they are being typed, so a half-typed
  // "1." or a momentarily empty field is not snapped back to 0.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Line CRUD lives here, so the rounding modal does too — both call sites get
  // the button without either having to wire it up.
  const [rounding, setRounding] = useState(false);

  const selectable = onToggleExclude !== undefined;
  const isExcluded = (lineId: string) => excludedIds?.has(lineId) ?? false;

  // Every line gets its amount computed, excluded ones included — an unticked
  // row still shows what it would bill rather than going blank (§1).
  const rows = computeMoney(lines, discountType, discountValue, taxPercent).lines;

  // The totals, however, cover only what will actually be billed, so the footer
  // matches the invoice about to be created rather than the rows on screen.
  // With nothing excluded this is the same call as before.
  const billed = selectable ? lines.filter((l) => !isExcluded(l.line_id)) : lines;
  const money = computeMoney(billed, discountType, discountValue, taxPercent);
  const overDiscounted = money.discount_amount > money.subtotal;

  const patch = (lineId: string, changes: Partial<InvoiceLine>) => {
    onChange(lines.map((l) => (l.line_id === lineId ? { ...l, ...changes } : l)));
  };

  // Sub-items are read off the source lines, not off `rows`, and always through
  // `?? []` — an invoice stored before sub_items existed has no array at all.
  const subItemsOf = (lineId: string): string[] =>
    lines.find((l) => l.line_id === lineId)?.sub_items ?? [];

  const setSubItem = (lineId: string, index: number, value: string) => {
    patch(lineId, { sub_items: subItemsOf(lineId).map((v, i) => (i === index ? value : v)) });
  };

  const removeSubItem = (lineId: string, index: number) => {
    patch(lineId, { sub_items: subItemsOf(lineId).filter((_, i) => i !== index) });
  };

  const addSubItem = (lineId: string) => {
    patch(lineId, { sub_items: [...subItemsOf(lineId), ''] });
  };

  const numericValue = (lineId: string, field: 'hours' | 'rate', value: number) => {
    const draft = drafts[`${lineId}:${field}`];
    return draft !== undefined ? draft : String(value);
  };

  const onNumericChange = (
    lineId: string, field: 'hours' | 'rate', raw: string
  ) => {
    setDrafts((prev) => ({ ...prev, [`${lineId}:${field}`]: raw }));
    const parsed = Number(raw);
    patch(lineId, { [field]: raw.trim() === '' || !Number.isFinite(parsed) ? 0 : parsed });
  };

  const onNumericBlur = (lineId: string, field: 'hours' | 'rate') => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[`${lineId}:${field}`];
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase tracking-wider">
              {selectable && <th className="w-8 pb-2" />}
              <th className="text-left font-medium pb-2 pr-2">Description</th>
              <th className="text-left font-medium pb-2 px-2 w-36">From</th>
              <th className="text-left font-medium pb-2 px-2 w-36">To</th>
              <th className="text-right font-medium pb-2 px-2 w-24">Hours</th>
              <th className="text-right font-medium pb-2 px-2 w-28">Rate</th>
              <th className="text-right font-medium pb-2 px-2 w-32">Amount</th>
              <th className="w-8 pb-2" />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={selectable ? 8 : 7} className="py-6 text-center text-sm text-slate-600">
                  No lines yet. Load time entries or add a line manually.
                </td>
              </tr>
            ) : (
              rows.map((line) => {
                const excluded = isExcluded(line.line_id);
                const reason = reasonForLine?.(line.line_id) ?? null;
                const subItems = line.sub_items ?? [];

                return (
                <tr
                  key={line.line_id}
                  // Dimmed, never disabled: an unticked line stays fully
                  // editable, and its inputs and amount keep rendering (§1).
                  className={`border-t border-slate-800 align-top ${excluded ? 'opacity-50' : ''}`}
                >
                  {selectable && (
                    <td className="py-2 pt-4">
                      <input
                        type="checkbox"
                        checked={!excluded}
                        onChange={() => onToggleExclude?.(line.line_id)}
                        title={excluded ? 'Include this line' : 'Leave this line off the invoice'}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-0"
                      />
                    </td>
                  )}
                  <td className="py-2 pr-2">
                    <input
                      type="text"
                      value={line.description}
                      onChange={(e) => patch(line.line_id, { description: e.target.value })}
                      placeholder={line.task_title || 'Description'}
                      className={CELL_INPUT}
                    />
                    {line.task_title && line.task_title !== line.description && (
                      <p className="text-xs text-slate-600 mt-1 truncate">
                        {line.task_title}
                        {line.project_name ? ` · ${line.project_name}` : ''}
                      </p>
                    )}

                    {reason && (
                      <p className="text-xs text-amber-300/90 mt-1 leading-snug">{reason}</p>
                    )}

                    {/* Task bullets printed under the description. Keyed by
                        index because the value IS the identity here — there is
                        nothing else on a bare string to key by. */}
                    <div className="mt-1.5 flex flex-col gap-1">
                      {subItems.map((item, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <span className="text-slate-600 text-xs select-none">•</span>
                          <input
                            type="text"
                            value={item}
                            onChange={(e) => setSubItem(line.line_id, i, e.target.value)}
                            placeholder="Task"
                            className={SUB_INPUT}
                          />
                          <button
                            onClick={() => removeSubItem(line.line_id, i)}
                            className="px-1 text-xs text-slate-600 hover:text-red-400 transition-colors leading-none"
                            title="Remove task"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {/* Offered on every line, not just tracker lines — a
                          manual line may want a task list too. */}
                      <button
                        onClick={() => addSubItem(line.line_id)}
                        className="self-start text-[11px] text-slate-500 hover:text-violet-300 transition-colors"
                      >
                        + Add task
                      </button>
                    </div>
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="date"
                      value={line.date_from ?? ''}
                      onChange={(e) => patch(line.line_id, { date_from: e.target.value })}
                      className={CELL_INPUT}
                    />
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="date"
                      value={line.date_to ?? ''}
                      onChange={(e) => patch(line.line_id, { date_to: e.target.value })}
                      className={CELL_INPUT}
                    />
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="number"
                      step="0.25"
                      value={numericValue(line.line_id, 'hours', line.hours)}
                      onChange={(e) => onNumericChange(line.line_id, 'hours', e.target.value)}
                      onBlur={() => onNumericBlur(line.line_id, 'hours')}
                      className={`${CELL_INPUT} text-right`}
                    />
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="number"
                      step="0.01"
                      value={numericValue(line.line_id, 'rate', line.rate)}
                      onChange={(e) => onNumericChange(line.line_id, 'rate', e.target.value)}
                      onBlur={() => onNumericBlur(line.line_id, 'rate')}
                      className={`${CELL_INPUT} text-right`}
                    />
                  </td>
                  <td className="py-2 px-2 text-right text-slate-200 tabular-nums pt-4">
                    {formatMoney(line.amount, currency)}
                  </td>
                  <td className="py-2 pt-4">
                    <button
                      onClick={() => onChange(lines.filter((l) => l.line_id !== line.line_id))}
                      className="p-1 text-slate-600 hover:text-red-400 transition-colors"
                      title="Remove line"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={() => onChange([...lines, newLine()])}
          className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add line
        </button>
        {/* Rounding only ever happens on this press — never on load, never on
            edit, never on save (§1: defaults, not constraints). */}
        <button
          onClick={() => setRounding(true)}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-violet-300 transition-colors"
          title="Snap hours to a billing increment"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 6v6h4.5M12 21a9 9 0 100-18 9 9 0 000 18z" />
          </svg>
          Round hours
        </button>
      </div>

      {rounding && (
        <RoundHoursModal
          lines={lines}
          currency={currency}
          // A caller that has not loaded settings passes nothing; falling back
          // keeps the feature reachable rather than opening a dead modal.
          defaultIncrement={
            roundingIncrement !== undefined && roundingIncrement > 0
              ? roundingIncrement
              : FALLBACK_INCREMENT
          }
          defaultDirection={roundingDirection ?? 'nearest'}
          // Same channel add and delete use — the parent stays the owner of the
          // array and saves on its own schedule.
          onApply={onChange}
          onClose={() => setRounding(false)}
        />
      )}

      {/* ── Totals ── */}
      <div className="flex justify-end">
        <div className="w-full sm:w-80 flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between text-slate-400">
            <span>Subtotal</span>
            <span className="tabular-nums text-slate-200">{formatMoney(money.subtotal, currency)}</span>
          </div>
          {discountType && (
            <div className="flex justify-between text-slate-400">
              <span>
                Discount{discountType === 'percent' ? ` (${discountValue}%)` : ''}
              </span>
              <span className="tabular-nums text-slate-200">
                −{formatMoney(money.discount_amount, currency)}
              </span>
            </div>
          )}
          {taxPercent !== 0 && (
            <div className="flex justify-between text-slate-400">
              <span>{taxLabel || 'Tax'} ({taxPercent}%)</span>
              <span className="tabular-nums text-slate-200">{formatMoney(money.tax_amount, currency)}</span>
            </div>
          )}
          <div className="flex justify-between pt-2 mt-1 border-t border-slate-700 text-base font-semibold">
            <span className="text-slate-200">Total</span>
            <span className={`tabular-nums ${money.total < 0 ? 'text-red-400' : 'text-slate-100'}`}>
              {formatMoney(money.total, currency)}
            </span>
          </div>
        </div>
      </div>

      {/* Over-discount: warn loudly, keep the value, never clamp (§5 rule 3) */}
      {overDiscounted && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2.5">
          <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <div className="text-xs leading-relaxed">
            <p className="text-red-300 font-medium">
              Discount exceeds the subtotal — this invoice totals {formatMoney(money.total, currency)}.
            </p>
            <p className="text-red-400/80 mt-0.5">
              The discount of {formatMoney(money.discount_amount, currency)} is larger than the
              subtotal of {formatMoney(money.subtotal, currency)}. The value is kept exactly as
              entered and will be saved as-is.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
