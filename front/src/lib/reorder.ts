// ─────────────────────────────────────────────────────────────────────────────
// Reordering invoice lines and their task bullets
//
// Kept out of the table component because the drop maths is the part that is
// easy to get subtly wrong and impossible to eyeball in a browser: an off-by-one
// on the insert index moves a line one row further than it was dropped, which
// looks like the drag "not quite working" rather than like a bug. Here it is a
// pure function over arrays, so it can be tested exhaustively.
//
// Three rules the whole file follows:
//
// 1. **Nothing is mutated.** Every function returns a new array, and every line
//    it touches is a new object. React state is the caller, and a spliced-in
//    place array would not re-render.
//
// 2. **A no-op returns the array it was given**, by identity. Dropping something
//    where it already was must not churn state or mark the invoice dirty.
//
// 3. **Money is not involved.** Reordering never touches `hours`, `rate` or
//    `amount`. The subtotal quantises each line to 2dp before summing, so it is
//    order-independent by construction — the tests assert this rather than
//    trusting it.
// ─────────────────────────────────────────────────────────────────────────────

import type { InvoiceLine } from '../types';

/** Where a task bullet sits: which line owns it, and its position within. */
export interface SubItemRef {
  lineId: string;
  index: number;
}

/**
 * Move one element of an array to another position.
 *
 * The insert index is read against the array *after* the element is removed,
 * which is what produces the behaviour a drag is expected to have: dropping
 * onto something below you lands you after it, dropping onto something above
 * lands you before it.
 */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to) return items;
  if (from < 0 || from >= items.length) return items;
  if (to < 0 || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** The bullets on a line. `?? []` throughout — an invoice stored before
 *  sub_items existed has no array at all. */
function subItemsOf(line: InvoiceLine): string[] {
  return line.sub_items ?? [];
}

/**
 * Reorder the invoice lines: put the dragged line where the target line is.
 *
 * @param lines     The current lines.
 * @param draggedId `line_id` of the line being dragged.
 * @param targetId  `line_id` of the line it was dropped on.
 * @returns A new array, or `lines` unchanged when the drop changes nothing or
 *          either id is unknown — an id that is not in the array means the drop
 *          landed on something that is no longer there, and dropping a line
 *          into oblivion is never the intent.
 */
export function moveLine(
  lines: InvoiceLine[],
  draggedId: string,
  targetId: string
): InvoiceLine[] {
  if (draggedId === targetId) return lines;
  const from = lines.findIndex((l) => l.line_id === draggedId);
  const to = lines.findIndex((l) => l.line_id === targetId);
  if (from === -1 || to === -1) return lines;
  return moveItem(lines, from, to);
}

/**
 * Move a task bullet — within its line, or onto a different line.
 *
 * Both cases are handled here rather than split into two functions, because the
 * same-line case is emphatically NOT "remove from source, then insert into
 * target": doing that in two passes reads the insert index against an array the
 * removal has already shifted, and the bullet lands one place off whenever it
 * moves downward.
 *
 * @param lines The current lines.
 * @param from  The bullet being dragged.
 * @param to    Where it should end up. `to.index` is clamped into range, so a
 *              drop past the end of a line appends rather than vanishing.
 * @returns A new array, or `lines` unchanged when nothing moves.
 */
export function moveSubItem(
  lines: InvoiceLine[],
  from: SubItemRef,
  to: SubItemRef
): InvoiceLine[] {
  const sourceIndex = lines.findIndex((l) => l.line_id === from.lineId);
  const targetIndex = lines.findIndex((l) => l.line_id === to.lineId);
  if (sourceIndex === -1 || targetIndex === -1) return lines;

  const sourceItems = subItemsOf(lines[sourceIndex]);
  if (from.index < 0 || from.index >= sourceItems.length) return lines;

  // ── Same line: one splice pair on one array, so the index maths stays honest.
  if (from.lineId === to.lineId) {
    const bounded = Math.max(0, Math.min(to.index, sourceItems.length - 1));
    if (bounded === from.index) return lines;
    const moved = moveItem(sourceItems, from.index, bounded);
    return lines.map((line, i) =>
      i === sourceIndex ? { ...line, sub_items: moved } : line
    );
  }

  // ── Across lines: the target index is read against the target's own array,
  // which the removal from the source line cannot have shifted.
  const targetItems = subItemsOf(lines[targetIndex]);
  const value = sourceItems[from.index];
  const bounded = Math.max(0, Math.min(to.index, targetItems.length));

  const nextSource = sourceItems.filter((_, i) => i !== from.index);
  const nextTarget = [...targetItems];
  nextTarget.splice(bounded, 0, value);

  return lines.map((line, i) => {
    if (i === sourceIndex) return { ...line, sub_items: nextSource };
    if (i === targetIndex) return { ...line, sub_items: nextTarget };
    return line;
  });
}

/**
 * Move a task bullet to the end of a line — what dropping onto a line's body,
 * rather than onto one of its bullets, should do.
 *
 * Dropping onto the line a bullet already belongs to sends it to the end of
 * that line, which is a real move and not a no-op.
 */
export function moveSubItemToLine(
  lines: InvoiceLine[],
  from: SubItemRef,
  targetLineId: string
): InvoiceLine[] {
  const target = lines.find((l) => l.line_id === targetLineId);
  if (!target) return lines;
  const length = subItemsOf(target).length;
  // Landing index differs by case: within the same line the bullet is removed
  // before it is re-inserted, so the last valid slot is one lower.
  const index = from.lineId === targetLineId ? length - 1 : length;
  return moveSubItem(lines, from, { lineId: targetLineId, index });
}
