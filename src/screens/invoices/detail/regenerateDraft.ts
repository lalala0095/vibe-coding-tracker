// The adapter between the invoice editor's draft and the regenerate merge.
//
// `lib/regenerate.ts` is a verbatim copy of the web's and speaks `InvoiceLine`:
// `hours` and `rate` are numbers, and every line carries a server-assigned
// `line_id`. This screen edits an `InvoiceDraft` of `LineDraft`s, where those
// two fields are raw text (so a half-typed "1." survives a keystroke) and every
// line carries a local `key`. Neither shape is wrong; they answer different
// questions, and this file is the only place they meet.
//
// ── Why the merge is not given the draft directly ────────────────────────────
//
// `mergeRegeneratedLines` decides which fields are facts about the work
// (refreshed: hours, session_ids, date_from, date_to) and which are authored by
// the owner (preserved: rate, description, sub_items, task_title). Rewriting
// that split against `LineDraft` would be a second implementation of the rule,
// and the failure mode is silent — a rate typed on the phone quietly discarded
// where the web would have kept it. So the draft is converted, merged by the
// shared code, and converted back.
//
// ── Keys are the subtle part ─────────────────────────────────────────────────
//
// `key` is local and never sent, but it is what React reconciles rows on. Two
// rules follow, and breaking either is invisible until someone is typing:
//
//   1. A line that survives the merge must keep the key it already had.
//      Re-keying a row unmounts its `TextInput`, which drops focus and the
//      caret mid-edit.
//   2. A line the merge ADDS needs a key of its own. `draft.ts:lineDraft`
//      keys off `line_id`, and a line that has never been saved has
//      `line_id: ''` — so keying added lines that way would give every one of
//      them the same key and React would collapse them into one row.
//
// Hence the two lookup maps below, built from the drafts that went in, and the
// counter for anything that comes back without a match.

import { parseNumberInput } from '@/components';
import type { InvoiceLine } from '@/types';

import type { LineDraft } from './draft';

// A counter rather than a timestamp: two lines added in the same millisecond
// would collide. Mirrors `draft.ts:addedLineCount`, and uses a distinct prefix
// so a key from here can never coincide with one from there.
let regeneratedLineCount = 0;

/**
 * The draft's lines as the merge wants them.
 *
 * `hours` and `rate` fall back to 0 when the text is unusable, exactly as
 * `toUpdatePayload` does on save — so what the merge compares against is what
 * the server would have been sent.
 *
 * `amount` is 0 and not a computed figure. The server recomputes every amount
 * on write (`InvoiceLineInput` has no `amount` field at all), the merge only
 * carries the value through untouched, and computing one here would be a second
 * implementation of the money rules for a number nobody reads.
 */
export function draftLinesToInvoiceLines(lines: LineDraft[]): InvoiceLine[] {
  return (lines ?? []).map((line) => ({
    line_id: line.line_id,
    task_id: line.task_id,
    task_title: line.task_title,
    project_id: line.project_id,
    project_name: line.project_name,
    description: line.description,
    date_from: line.date_from,
    date_to: line.date_to,
    hours: parseNumberInput(line.hours) ?? 0,
    rate: parseNumberInput(line.rate) ?? 0,
    amount: 0,
    session_ids: line.session_ids ?? [],
    tracker_id: line.tracker_id,
    sub_items: line.sub_items ?? [],
  }));
}

/**
 * The merged lines back as draft rows, reusing each row's existing key.
 *
 * `previous` is the draft the merge ran against. A merged line is matched to it
 * by `line_id` first — the merge preserves that field, so it is the identity
 * that actually survives — and by provenance second, which is what carries a
 * line that has never been saved and therefore has no id yet.
 *
 * Numbers become text through `String`, not `toFixed`: this text is parsed back
 * on save, 2.5 must stay "2.5" rather than becoming "2.50", and `toFixed` is the
 * half-cent trap `draft.ts:numberText` documents.
 */
export function invoiceLinesToDraftLines(
  merged: InvoiceLine[],
  previous: LineDraft[]
): LineDraft[] {
  const byLineId = new Map<string, string>();
  const byProvenance = new Map<string, string>();

  for (const line of previous ?? []) {
    if (line.line_id) byLineId.set(line.line_id, line.key);
    const provenance = provenanceKey(line.tracker_id, line.task_id, line.project_id);
    // First writer wins: if two unsaved lines somehow share provenance, the
    // second must get a fresh key rather than steal the first one's row.
    if (provenance && !byProvenance.has(provenance)) byProvenance.set(provenance, line.key);
  }

  const used = new Set<string>();

  return (merged ?? []).map((line) => {
    const provenance = provenanceKey(line.tracker_id, line.task_id, line.project_id);
    let key = (line.line_id ? byLineId.get(line.line_id) : undefined)
      ?? (provenance ? byProvenance.get(provenance) : undefined);

    // A key already claimed by an earlier row cannot be reused — two rows with
    // the same key is the collapse this whole function exists to avoid.
    if (key === undefined || used.has(key)) {
      regeneratedLineCount += 1;
      key = `regenerated-${regeneratedLineCount}`;
    }
    used.add(key);

    return {
      key,
      line_id: line.line_id,
      task_id: line.task_id,
      task_title: line.task_title,
      project_id: line.project_id,
      project_name: line.project_name,
      description: line.description,
      date_from: line.date_from,
      date_to: line.date_to,
      hours: numberText(line.hours),
      rate: numberText(line.rate),
      session_ids: line.session_ids ?? [],
      tracker_id: line.tracker_id,
      sub_items: line.sub_items ?? [],
    };
  });
}

/**
 * How the merge itself identifies a line's source: the tracker it came from, or
 * the (task, project) pair. Null for a manual line, which has no source and is
 * therefore matched only by `line_id`.
 *
 * Spelled the same way as `lib/regenerate.ts`'s own source key (its lines
 * 104-105, `|` separator included) so the two cannot be confused for different
 * schemes when read side by side. Nothing enforces that they agree, and nothing
 * needs to: this only carries a React key across the merge, so a disagreement
 * would cost a remounted row and never a wrong figure.
 */
function provenanceKey(
  trackerId: string | null,
  taskId: string | null,
  projectId: string | null
): string | null {
  if (trackerId) return `tracker:${trackerId}`;
  if (taskId) return `task:${taskId}|${projectId ?? ''}`;
  return null;
}

/** A stored number as editable text. Mirrors `draft.ts:numberText`. */
function numberText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(value);
}
