// A labelled text input.
//
// There is deliberately no `editable` / `readOnly` prop, and adding one would
// break CLAUDE.md's no-locking rule. To flag a value, pass `warning` or
// `error`; both render as visible notes and neither blocks typing.

import { TextInput, View } from 'react-native';

import { theme } from '@/theme';
import FieldFrame, { fieldBorder, type FieldNotes } from './FieldFrame';

export interface TextFieldProps extends FieldNotes {
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  /** Grows to `numberOfLines` rows and keeps the text top-aligned. */
  multiline?: boolean;
  /** Only meaningful with `multiline`. Defaults to 4. */
  numberOfLines?: number;
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'decimal-pad' | 'url';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  returnKeyType?: 'done' | 'next' | 'go' | 'send';
  onSubmitEditing?: () => void;
  onBlur?: () => void;
  className?: string;
  inputClassName?: string;
  testID?: string;
}

export default function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  numberOfLines = 4,
  keyboardType = 'default',
  autoCapitalize = 'sentences',
  autoCorrect = true,
  autoFocus = false,
  maxLength,
  returnKeyType,
  onSubmitEditing,
  onBlur,
  error,
  warning,
  hint,
  className,
  inputClassName = '',
  testID,
}: TextFieldProps) {
  return (
    <FieldFrame label={label} error={error} warning={warning} hint={hint} className={className}>
      <View className={`rounded-lg border bg-slate-950 ${fieldBorder(error)}`}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.textFaint}
          selectionColor={theme.accent}
          multiline={multiline}
          numberOfLines={multiline ? numberOfLines : 1}
          textAlignVertical={multiline ? 'top' : 'center'}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          autoFocus={autoFocus}
          maxLength={maxLength}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          onBlur={onBlur}
          className={[
            'px-3 text-base text-slate-100',
            multiline ? 'py-3' : 'py-2.5',
            inputClassName,
          ].join(' ')}
          style={multiline ? { minHeight: 24 * numberOfLines } : undefined}
          testID={testID}
        />
      </View>
    </FieldFrame>
  );
}
