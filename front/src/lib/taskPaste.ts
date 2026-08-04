// ─────────────────────────────────────────────────────────────────────────────
// Turning pasted text into a list of task titles.
//
// The text people actually paste comes in three shapes and often mixes them:
// one task per line (a spreadsheet column), tab-separated (a spreadsheet row),
// and a single run-on paragraph where each sentence is a task. All three are
// handled here; the caller shows the result as an editable list, so a wrong
// guess costs an edit, not a re-paste.
// ─────────────────────────────────────────────────────────────────────────────

/** Leading bullet or numbering: "- ", "* ", "• ", "1. ", "2) ". */
const BULLET = /^\s*(?:[-*•–—]|\d+[.)])\s+/;

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

/**
 * Cut text into sentences at ".", "!" and "?".
 *
 * A period wedged between two digits is part of a number — "v1.2", "1.5 hours",
 * "v1.4.0" — and never ends a sentence. Deciding that needs the character
 * *before* the period, which a regex would want lookbehind for; this is a plain
 * forward scan instead, so the build target stays wide.
 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  // Leading terminators belong to no sentence — "…and then" opens with "and".
  let hasContent = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char !== '.' && char !== '!' && char !== '?') {
      current += char;
      hasContent = true;
      continue;
    }

    if (char === '.' && isDigit(text[i - 1]) && isDigit(text[i + 1])) {
      current += char;
      continue;
    }

    if (!hasContent) continue;

    // Keep the whole run of terminators with the sentence it closes ("Done!!").
    while (i < text.length && (text[i] === '.' || text[i] === '!' || text[i] === '?')) {
      current += text[i];
      i += 1;
    }
    i -= 1;

    sentences.push(current);
    current = '';
    hasContent = false;
  }

  if (hasContent) sentences.push(current);

  return sentences;
}

/**
 * Split one cell of pasted text into task titles.
 *
 * A cell holding several sentences becomes several tasks — that is the whole
 * point of pasting a paragraph — while a cell with no sentence break stays a
 * single task, punctuation and all.
 */
function splitCell(raw: string): string[] {
  const cleaned = raw.replace(BULLET, '').trim();
  if (!cleaned) return [];

  return splitSentences(cleaned)
    // Trailing full stops read as punctuation on a title, not part of it. "?"
    // and "!" are kept — a title can legitimately end in either.
    .map((sentence) => sentence.trim().replace(/\.+$/, '').trim())
    .filter(Boolean);
}

/**
 * Parse pasted text into task titles.
 *
 * Blank entries are dropped and repeats are collapsed, keeping first-seen
 * order — pasting the same list twice must not create the task twice.
 *
 * @param text Raw clipboard text.
 * @returns The titles, in the order they appeared.
 */
export function parseTaskList(text: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();

  for (const line of (text || '').split(/\r?\n/)) {
    for (const cell of line.split('\t')) {
      for (const title of splitCell(cell)) {
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        titles.push(title);
      }
    }
  }

  return titles;
}
