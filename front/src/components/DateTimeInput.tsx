import { useState } from 'react';
import { parseFlexibleDateTime, describeDateTime } from '../lib/datetime';

// ─────────────────────────────────────────────────────────────────────────────
// A datetime-local input you can paste a spreadsheet timestamp into.
//
// Two ways in, because neither alone is reliable:
//
//   1. Pasting straight onto the picker. Browsers fire the paste event but
//      refuse to insert anything that is not already in datetime-local shape,
//      so the handler parses the clipboard itself.
//   2. A text mode toggle, for browsers that swallow the event and for typing a
//      timestamp by hand. Unparseable text stays on screen rather than being
//      silently discarded, so nothing is lost mid-correction.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  /** "YYYY-MM-DDTHH:mm", or "" when unset. */
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export default function DateTimeInput({ value, onChange, className = '' }: Props) {
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState('');

  const field =
    className ||
    'w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm ' +
      'placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!pasted.trim()) return;
    e.preventDefault();
    const parsed = parseFlexibleDateTime(pasted);
    if (parsed) {
      onChange(parsed);
      return;
    }
    // Could not read it — hand the raw text to the editable field rather than
    // dropping it, so the user can fix it in place.
    setText(pasted.trim());
    setTextMode(true);
  };

  const handleText = (raw: string) => {
    setText(raw);
    const parsed = parseFlexibleDateTime(raw);
    if (parsed) onChange(parsed);
  };

  const parsedFromText = textMode ? parseFlexibleDateTime(text) : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-stretch gap-1.5">
        {textMode ? (
          <input
            type="text"
            value={text}
            onChange={(e) => handleText(e.target.value)}
            placeholder="7/13/2026 12:29:32"
            autoFocus
            className={field}
          />
        ) : (
          <input
            type="datetime-local"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPaste={handlePaste}
            className={field}
          />
        )}
        <button
          type="button"
          onClick={() => {
            if (textMode) {
              setTextMode(false);
              setText('');
            } else {
              setText('');
              setTextMode(true);
            }
          }}
          title={textMode ? 'Back to the date picker' : 'Paste or type a timestamp'}
          className="shrink-0 px-2.5 text-xs rounded-lg bg-slate-800 border border-slate-700
                     text-slate-400 hover:text-slate-100 transition-colors"
        >
          {textMode ? 'Pick' : 'Paste'}
        </button>
      </div>

      {textMode && (
        <p className={`text-xs ${parsedFromText ? 'text-green-400' : text.trim() ? 'text-amber-400' : 'text-slate-500'}`}>
          {parsedFromText
            ? `→ ${describeDateTime(parsedFromText)}`
            : text.trim()
            ? 'Not a timestamp yet — try 7/13/2026 12:29:32'
            : 'Paste a timestamp from a spreadsheet.'}
        </p>
      )}
    </div>
  );
}
