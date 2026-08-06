import { useState } from 'react';
import type { InvoiceLine, HoursRoundingDirection } from '../types';
import { roundHoursToIncrement } from '../lib/money';
import Modal, { MODAL_CANCEL_BUTTON, MODAL_PRIMARY_BUTTON } from './Modal';
// The form classes live with the other shared invoice-UI pieces rather than
// being restated here, which is what let the three dialogs drift.
import { FIELD, LABEL, CHECKBOX } from './InvoiceBuilder';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PRESETS: { value: number; label: string }[] = [
  { value: 0.25, label: '15 min · 0.25' },
  { value: 0.5, label: '30 min · 0.5' },
  { value: 1, label: '1 hour · 1' },
];

const DIRECTIONS: { value: HoursRoundingDirection; label: string }[] = [
  { value: 'nearest', label: 'Nearest' },
  { value: 'up', label: 'Always up' },
  { value: 'down', label: 'Always down' },
];

function hoursText(value: number): string {
  return `${value.toFixed(2)}h`;
}

function titleOf(line: InvoiceLine): string {
  return line.description || line.task_title || 'Untitled line';
}

// ── Modal ─────────────────────────────────────────────────────────────────────

interface Props {
  lines: InvoiceLine[];
  currency: string;
  defaultIncrement: number;
  defaultDirection: HoursRoundingDirection;
  onApply: (lines: InvoiceLine[]) => void;
  onClose: () => void;
}

/**
 * Snap invoice-line hours to a billing increment.
 *
 * Rounding is never automatic: the owner picks the increment, the direction and
 * the exact lines, sees every before → after transition, and only then applies.
 * Nothing here is written to the server — the surface's own Save does that.
 */
export default function RoundHoursModal({
  lines, currency, defaultIncrement, defaultDirection, onApply, onClose,
}: Props) {
  // The increment is held as raw text so a half-typed "0." is not snapped back,
  // the same reason InvoiceLineTable keeps drafts for its numeric cells.
  const [incrementText, setIncrementText] = useState(() => String(defaultIncrement ?? ''));
  const [direction, setDirection] = useState<HoursRoundingDirection>(defaultDirection ?? 'nearest');
  // Everything is in scope by default — the common case is "round the lot".
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(lines.map((l) => l.line_id))
  );

  const increment = Number(incrementText);
  const incrementValid = Number.isFinite(increment) && increment > 0;

  const toggle = (lineId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId); else next.add(lineId);
      return next;
    });
  };

  // Every row is previewed, selected or not, so unticking a line shows what it
  // is being spared rather than blanking out.
  const rows = lines.map((line) => {
    const after = incrementValid
      ? roundHoursToIncrement(line.hours, increment, direction)
      : line.hours;
    return {
      line,
      before: line.hours,
      after,
      moves: after !== line.hours,
      lowers: after < line.hours,
      picked: selected.has(line.line_id),
    };
  });

  const picked = rows.filter((r) => r.picked);
  const hoursBefore = picked.reduce((sum, r) => sum + r.before, 0);
  const hoursAfter = picked.reduce((sum, r) => sum + r.after, 0);
  const delta = hoursAfter - hoursBefore;
  const movingCount = picked.filter((r) => r.moves).length;
  // Billing less than was tracked is a legitimate choice, but a deliberate one.
  const loweredCount = picked.filter((r) => r.lowers).length;

  const handleApply = () => {
    // A fresh array of fresh objects: the caller's lines are never mutated, and
    // `amount` rides through untouched because the server recomputes all money.
    onApply(
      lines.map((line) =>
        selected.has(line.line_id) && incrementValid
          ? { ...line, hours: roundHoursToIncrement(line.hours, increment, direction) }
          : line
      )
    );
    onClose();
  };

  return (
    <Modal
      title="Round hours"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <span className="text-xs text-slate-500">
            {incrementValid
              ? `Rounding to ${increment} h, ${DIRECTIONS.find((d) => d.value === direction)?.label.toLowerCase()}.`
              : 'No increment set.'}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className={MODAL_CANCEL_BUTTON}>
              {incrementValid ? 'Cancel' : 'Close'}
            </button>
            {/* Offered only when it would do something — an invalid increment or
                an empty selection has no meaningful Apply. */}
            {incrementValid && picked.length > 0 && (
              <button onClick={handleApply} className={MODAL_PRIMARY_BUTTON}>
                Apply to {picked.length} line{picked.length !== 1 ? 's' : ''}
              </button>
            )}
          </div>
        </>
      }
    >
      {/* ── Step 1: the rule ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <label className={LABEL}>Increment (hours)</label>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => setIncrementText(String(p.value))}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  increment === p.value
                    ? 'bg-violet-500/15 border-violet-500/40 text-violet-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="number"
            step="0.05"
            min="0"
            value={incrementText}
            onChange={(e) => setIncrementText(e.target.value)}
            placeholder="e.g. 0.25"
            className={FIELD}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className={LABEL}>Direction</label>
          <div className="flex flex-col gap-1.5">
            {DIRECTIONS.map((d) => (
              <label key={d.value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="hours-rounding-direction"
                  checked={direction === d.value}
                  onChange={() => setDirection(d.value)}
                  className="w-4 h-4 border-slate-600 bg-slate-800 text-violet-600 focus:ring-2 focus:ring-violet-500 focus:ring-offset-0"
                />
                <span className="text-sm text-slate-300">{d.label}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-slate-500 leading-snug">
            "Always up" never lowers a figure — it only ever bills the same or more.
          </p>
        </div>
      </div>

      {!incrementValid ? (
        <p className="text-sm text-slate-400 bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2.5 leading-relaxed">
          Rounding is off. Enter an increment greater than zero — 0.25 for quarter hours,
          0.5 for half hours, 1 for whole hours — and the lines below will preview.
        </p>
      ) : (
        <>
          {/* ── Step 2: which lines, and what happens to each ── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Lines to round
              </span>
              <div className="flex items-center gap-3 text-xs">
                <button
                  onClick={() => setSelected(new Set(lines.map((l) => l.line_id)))}
                  className="text-violet-400 hover:text-violet-300 transition-colors"
                >
                  Select all
                </button>
                <button
                  onClick={() => setSelected(new Set())}
                  className="text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Select none
                </button>
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="text-sm text-slate-600 py-4 text-center">
                This invoice has no lines yet.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {rows.map((r) => (
                  <label
                    key={r.line.line_id}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      !r.picked
                        ? 'border-slate-800 bg-slate-800/20 opacity-60'
                        : r.lowers
                          ? 'border-amber-400/30 bg-amber-400/5'
                          : r.moves
                            ? 'border-green-400/25 bg-green-400/5'
                            : 'border-slate-700 bg-slate-800/40'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={r.picked}
                      onChange={() => toggle(r.line.line_id)}
                      className={CHECKBOX}
                    />
                    <span className="text-sm text-slate-200 truncate flex-1 min-w-0">
                      {titleOf(r.line)}
                    </span>
                    {/* A line already on the increment shows one number and
                        no arrow, so "nothing happens here" reads at a glance. */}
                    {r.moves ? (
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">
                        {hoursText(r.before)}
                        <span className="mx-1 text-slate-500">→</span>
                        <span className={r.lowers ? 'text-amber-300 font-medium' : 'text-green-300 font-medium'}>
                          {hoursText(r.after)}
                        </span>
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs tabular-nums text-slate-500">
                        {hoursText(r.before)} · unchanged
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* ── The headline, before anything is committed ── */}
          <div className="flex items-baseline gap-2 flex-wrap border-t border-slate-800 pt-4">
            <span className="text-sm text-slate-400">
              {picked.length} of {lines.length} line{lines.length !== 1 ? 's' : ''} selected
              {movingCount > 0 ? ` · ${movingCount} will move` : ' · nothing will move'}
            </span>
            <span className="text-sm text-slate-300 tabular-nums ml-auto">
              {hoursText(hoursBefore)}
            </span>
            <span className="text-slate-500">→</span>
            <span className={`text-base font-semibold tabular-nums ${
              delta > 0 ? 'text-green-300' : delta < 0 ? 'text-amber-300' : 'text-slate-200'
            }`}>
              {hoursText(hoursAfter)}
            </span>
          </div>

          {loweredCount > 0 && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
              <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <p className="text-xs text-amber-300 leading-relaxed">
                {loweredCount} selected line{loweredCount !== 1 ? 's bill' : ' bills'} fewer hours
                than tracked — {hoursText(Math.abs(delta))} less in total. That is allowed; just
                make sure it is what you want.
              </p>
            </div>
          )}

          <p className="text-xs text-slate-500 leading-relaxed">
            Only hours change. Rates, descriptions and dates are untouched, and amounts in{' '}
            {currency} are recalculated when you save. Nothing is written to the server here.
          </p>
        </>
      )}
    </Modal>
  );
}
