// Due date, payment terms and notes — the wording on the document rather than
// the arithmetic behind it.
//
// All three are string-ish fields cleared with the literal `"null"` sentinel;
// that translation happens once, in `toUpdatePayload`, so this card can deal in
// plain empty values and `null`.

import { Text, View } from 'react-native';

import { DateTimeField, TextField } from '@/components';
import { dayFromFieldValue, type InvoiceDraft } from '@/screens/invoices/detail/draft';

export interface MetaCardProps {
  draft: InvoiceDraft;
  onChange: (patch: Partial<InvoiceDraft>) => void;
  /** The invoice's issue date, for the "due before it was issued" check. */
  issueDate: string;
}

export default function MetaCard({ draft, onChange, issueDate }: MetaCardProps) {
  // `YYYY-MM-DD` compares exactly as a string, so no `Date` is built and no
  // timezone is involved.
  const dueBeforeIssue =
    draft.due_date !== null && issueDate !== '' && draft.due_date < issueDate;

  return (
    <View className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
        Terms &amp; notes
      </Text>

      <View className="mt-3 gap-3">
        <DateTimeField
          label="Due date"
          mode="date"
          clearable
          value={draft.due_date}
          onChange={(value) => onChange({ due_date: dayFromFieldValue(value) })}
          placeholder="No due date"
          warning={dueBeforeIssue ? 'Falls before the issue date.' : undefined}
        />

        <TextField
          label="Payment terms"
          value={draft.payment_terms}
          onChangeText={(payment_terms) => onChange({ payment_terms })}
          placeholder="Net 14"
        />

        <TextField
          label="Notes"
          value={draft.notes}
          onChangeText={(notes) => onChange({ notes })}
          placeholder="Anything that should appear on the invoice"
          multiline
          numberOfLines={4}
        />
      </View>
    </View>
  );
}
