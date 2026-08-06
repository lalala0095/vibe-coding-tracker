// The one confirmation dialog. Replaces seven hand-rolled two-step inline
// confirms, one window.confirm, and covers the deletes that had no confirmation
// at all.
//
// It owns the in-flight and error state rather than making every caller repeat
// it, which is what fixes the bug the old copies shared: several of them left
// the row stuck in its "Delete?" state with a spinner that had stopped, because
// the catch branch reset `deleting` but not `confirm`, and three swallowed the
// error entirely so a failed delete looked exactly like a successful one.
//
// Here a failure keeps the dialog open, stops the spinner, and says what went
// wrong. Success is the only path that closes it.

import { useEffect, useState, type ReactNode } from 'react';
import Modal, {
  ButtonSpinner,
  MODAL_CANCEL_BUTTON,
  MODAL_DANGER_BUTTON,
  MODAL_PRIMARY_BUTTON,
} from './Modal';

interface Props {
  open: boolean;
  title: string;
  /** The question. Name the thing being deleted — "Delete invoice INV-2026-013?" */
  message: ReactNode;
  /** Optional second line for a consequence worth spelling out. */
  detail?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  /**
   * Awaited. Throwing keeps the dialog open and surfaces the message, so a
   * caller reports failure by letting the error propagate — it does not need
   * to catch and thread state back in.
   */
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  /** Shown when onConfirm throws something without a usable message. */
  errorFallback?: string;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onClose,
  errorFallback = 'That did not work. Please try again.',
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Reopening after a failure must not show the previous attempt's error, and
  // the same dialog instance is reused across different targets.
  useEffect(() => {
    if (open) {
      setBusy(false);
      setError('');
    }
  }, [open]);

  if (!open) return null;

  const handleConfirm = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      // Deliberately no setBusy(false) on success: the caller closes or
      // unmounts us, and clearing it first flashes the button back to idle.
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error && e.message ? e.message : errorFallback);
      setBusy(false);
    }
  };

  // Escape and backdrop stay live while busy — a request already in flight is
  // not a reason to trap someone in a dialog. The button guards the double
  // submit; the dialog does not hold the page hostage.
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="sm"
      bodyClassName="p-5 flex flex-col gap-3"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={MODAL_CANCEL_BUTTON}>
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={tone === 'danger' ? MODAL_DANGER_BUTTON : MODAL_PRIMARY_BUTTON}
          >
            {busy && <ButtonSpinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-200 leading-relaxed">{message}</p>
      {detail && <p className="text-xs text-slate-400 leading-relaxed">{detail}</p>}
      {error && (
        <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
    </Modal>
  );
}
