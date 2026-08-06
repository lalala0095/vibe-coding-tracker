// The one modal shell. Every dialog in the app sits inside this.
//
// Before this existed there were nine hand-rolled `fixed inset-0` overlays in
// three visual dialects, differing in backdrop opacity, corner radius, border
// colour, padding, max height and title size. None of them had ARIA, none
// closed on Escape, and none locked body scroll.
//
// The part that is easy to get wrong, and the reason this is one component
// rather than a copied snippet: **modals nest**. RoundHoursModal opens inside
// InvoiceBuilder. A naive `document.body.style.overflow = 'hidden'` with a
// cleanup that resets it would let the inner dialog unlock the page while the
// outer one is still open, and a naive Escape listener would close both at
// once. So the open dialogs form a stack, only the topmost answers Escape, and
// the scroll lock is reference-counted.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

// ── The open-dialog stack ─────────────────────────────────────────────────────
// Module scope on purpose: this is a property of the document, not of any one
// React tree, and dialogs mounted from unrelated components must still see one
// another.

const stack: string[] = [];
let restoreOverflow: string | null = null;

function pushDialog(id: string): void {
  stack.push(id);
  if (stack.length === 1) {
    // Remember what the page had rather than assuming '' — a future layout may
    // legitimately set its own overflow.
    restoreOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
}

function popDialog(id: string): void {
  const index = stack.lastIndexOf(id);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0) {
    document.body.style.overflow = restoreOverflow ?? '';
    restoreOverflow = null;
  }
}

function isTopmost(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

// ── Sizes ─────────────────────────────────────────────────────────────────────
// Named rather than free-form so a new dialog cannot invent a tenth width.

const SIZES = {
  sm: 'max-w-md',    // confirmations, short forms
  md: 'max-w-2xl',   // most forms
  lg: 'max-w-3xl',   // wizards with a summary pane
  xl: 'max-w-4xl',   // the invoice builder
} as const;

export type ModalSize = keyof typeof SIZES;

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Rendered in the footer bar. Omit for a dialog with no actions of its own. */
  footer?: ReactNode;
  size?: ModalSize;
  /** Panel cap. The body scrolls; the header and footer stay put. */
  maxHeight?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  showClose?: boolean;
  /** Extra classes for the scrolling body, e.g. a different padding or gap. */
  bodyClassName?: string;
}

export default function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'md',
  maxHeight = '90vh',
  closeOnBackdrop = true,
  closeOnEscape = true,
  showClose = true,
  bodyClassName = 'p-5 flex flex-col gap-5',
}: Props) {
  const id = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Depth decides z-index, so a dialog opened from inside another paints above
  // it instead of relying on DOM order the way the old copies did.
  const [depth, setDepth] = useState(0);

  // `onClose` is read through a ref so a caller passing an inline arrow does not
  // re-register the key listener, and re-order the stack, on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    setDepth(stack.length);
    pushDialog(id);
    return () => popDialog(id);
  }, [id]);

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Only the top dialog reacts, or Escape would close a whole nested stack.
      if (e.key === 'Escape' && isTopmost(id)) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [id, closeOnEscape]);

  // Move focus into the panel so the keyboard starts inside the dialog rather
  // than back at the top of the page behind it.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    // Compared against the overlay itself: a bare onClick would also fire for
    // every click that bubbles up from inside the panel.
    if (closeOnBackdrop && e.target === overlayRef.current) onClose();
  };

  const titleId = `${id}-title`;

  return (
    <div
      ref={overlayRef}
      onMouseDown={handleBackdrop}
      className="fixed inset-0 flex items-center justify-center bg-black/70 p-4"
      style={{ zIndex: 50 + depth * 10 }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full ${SIZES[size]} bg-slate-900 border border-slate-700 rounded-xl shadow-2xl
                    flex flex-col overflow-hidden outline-none`}
        style={{ maxHeight }}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-slate-700 shrink-0">
          <h2 id={titleId} className="text-base font-semibold text-white">
            {title}
          </h2>
          {showClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 text-slate-500 hover:text-slate-300 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className={`flex-1 overflow-y-auto ${bodyClassName}`}>{children}</div>

        {footer && (
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-700 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared button classes ─────────────────────────────────────────────────────
// Exported so dialogs stop re-deriving them. The cancel style was already
// unanimous across six call sites, so it is taken as-is rather than redesigned.

export const MODAL_CANCEL_BUTTON =
  'px-4 py-2 text-sm rounded-lg text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50';

export const MODAL_DANGER_BUTTON =
  'px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-500 ' +
  'transition-colors disabled:opacity-50 flex items-center gap-2';

export const MODAL_PRIMARY_BUTTON =
  'px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-500 ' +
  'transition-colors disabled:opacity-50 flex items-center gap-2';

export function ButtonSpinner() {
  return <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />;
}
