// The one confirmation dialog, ported from `front/src/components/ConfirmDialog.tsx`.
//
// It owns the in-flight and error state rather than making every caller repeat
// it, which is what fixed the bug the web's hand-rolled copies shared: a failed
// delete looked exactly like a successful one, because the catch branch cleared
// the spinner and nothing said what went wrong.
//
// Here a failure keeps the sheet open, stops the spinner, and shows the
// message. Success is the only path that closes it.

import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import { apiErrorMessage } from '@/api';
import Button from './Button';

export interface ConfirmSheetProps {
  open: boolean;
  title: string;
  /** The question. Name the thing — "Delete this time entry?" */
  message: ReactNode;
  /** A second line for a consequence worth spelling out. */
  detail?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  /**
   * Awaited. Throwing keeps the sheet open and surfaces the message, so a
   * caller reports failure by letting the error propagate — it does not need
   * to catch and thread state back in.
   */
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  /** Used when the thrown value carries no usable message. */
  errorFallback?: string;
  testID?: string;
}

export default function ConfirmSheet({
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
  testID,
}: ConfirmSheetProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { height } = useWindowDimensions();

  // Reopening after a failure must not show the previous attempt's error, and
  // one instance is typically reused across different targets.
  useEffect(() => {
    if (open) {
      setBusy(false);
      setError('');
    }
  }, [open]);

  const handleConfirm = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      // Deliberately no setBusy(false) on success: the caller closes or
      // unmounts us, and clearing it first flashes the button back to idle.
      onClose();
    } catch (e: unknown) {
      setError(apiErrorMessage(e, errorFallback));
      setBusy(false);
    }
  };

  // The backdrop and the back button stay live while busy — a request already
  // in flight is not a reason to trap someone in a dialog. The confirm button
  // guards the double submit; the sheet does not hold the screen hostage.
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/60 px-6" onPress={onClose}>
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900"
          style={{ maxHeight: height * 0.8 }}
          testID={testID}
        >
          <View className="border-b border-slate-800 px-5 py-4">
            <Text className="text-base font-semibold text-slate-100">{title}</Text>
          </View>

          <ScrollView className="px-5 py-4">
            <View className="gap-3">
              {typeof message === 'string' ? (
                <Text className="text-sm leading-relaxed text-slate-200">{message}</Text>
              ) : (
                message
              )}

              {detail ? (
                typeof detail === 'string' ? (
                  <Text className="text-xs leading-relaxed text-slate-400">{detail}</Text>
                ) : (
                  detail
                )
              ) : null}

              {error ? (
                <View className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2">
                  <Text className="text-sm text-red-400">{error}</Text>
                </View>
              ) : null}
            </View>
          </ScrollView>

          <View className="flex-row gap-3 border-t border-slate-800 px-5 py-4">
            <View className="flex-1">
              <Button label={cancelLabel} onPress={onClose} variant="secondary" disabled={busy} />
            </View>
            <View className="flex-1">
              <Button
                label={confirmLabel}
                onPress={handleConfirm}
                variant={tone === 'danger' ? 'danger' : 'primary'}
                loading={busy}
              />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
