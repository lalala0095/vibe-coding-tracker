// Create or edit one project. The same form does both.
//
// A project is a name, a client, and a rate that may or may not exist. The rate
// is the interesting field: empty means "inherit the client's default", which is
// a different thing from 0, and the hint under the box resolves whichever one is
// currently selected so the answer is on screen rather than inferred.
//
// No locking (CLAUDE.md): a negative rate warns and saves. The save button's
// `loading` state is a double-submit guard and the only inert thing here.

import { useMemo, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import { apiErrorMessage } from '@/api';
import {
  Button,
  ErrorNote,
  NumberField,
  Screen,
  Select,
  TextField,
  type SelectOption,
} from '@/components';
import type { Client, Project } from '@/types';
import {
  clientRateLabel,
  describeProjectRate,
  parseRateInput,
  rateInputError,
  rateInputWarning,
  rateToInput,
} from './rates';

/** Plain values. `null` on `rate` means "cleared", i.e. inherit. */
export interface ProjectFormValues {
  name: string;
  client_id: string;
  /** `null` clears the override and inherits. `0` is a real rate of zero. */
  rate: number | null;
}

export interface ProjectFormProps {
  /** The project being edited, or `null` to create one. */
  project: Project | null;
  clients: Client[];
  /** Preselected client when adding from inside a client's card. */
  defaultClientId?: string | null;
  /** Throwing surfaces the message in the form and keeps it open. */
  onSubmit: (values: ProjectFormValues) => Promise<void>;
  onCancel: () => void;
}

interface FieldErrors {
  name?: string;
  client?: string;
  rate?: string;
}

export default function ProjectForm({
  project,
  clients,
  defaultClientId,
  onSubmit,
  onCancel,
}: ProjectFormProps) {
  const [name, setName] = useState(project?.name ?? '');
  const [clientId, setClientId] = useState<string | null>(
    project?.client_id ?? defaultClientId ?? null,
  );
  // Text, not a number: "" and "0" are the two values this screen exists to
  // keep apart. See the header of `rates.ts`.
  const [rate, setRate] = useState(rateToInput(project?.rate ?? null));

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const clientOptions: SelectOption[] = useMemo(() => {
    const options = clients.map((client) => ({
      label: client.name,
      value: client.id,
      sublabel: clientRateLabel(client),
    }));

    // The project's own client must always stay selectable even if it is
    // missing from the loaded list — otherwise opening the editor would blank
    // the picker and saving would move the project somewhere else.
    if (project && !options.some((option) => option.value === project.client_id)) {
      options.unshift({
        label: project.client_name || 'Client no longer exists',
        value: project.client_id,
        sublabel: 'Not in the client list',
      });
    }

    return options;
  }, [clients, project]);

  const selectedClient = clients.find((client) => client.id === clientId) ?? null;

  // Moving a project between clients refreshes its denormalised `client_name`
  // server-side, but nothing already written is rewritten.
  const reparenting = project !== null && clientId !== null && clientId !== project.client_id;
  const renaming = project !== null && name.trim() !== '' && name.trim() !== project.name;

  const handleSubmit = async () => {
    const next: FieldErrors = {};

    const trimmedName = name.trim();
    if (!trimmedName) next.name = 'A project needs a name.';
    if (!clientId) next.client = 'Choose the client this project belongs to.';

    const rateError = rateInputError(rate, 'Rate');
    if (rateError) next.rate = rateError;

    setErrors(next);
    if (Object.keys(next).length > 0 || !trimmedName || !clientId) return;

    setSubmitError('');
    setSubmitting(true);
    try {
      await onSubmit({
        name: trimmedName,
        client_id: clientId,
        // "" → null inherits the client default; "0" → 0 is a real zero rate.
        rate: parseRateInput(rate),
      });
    } catch (e: unknown) {
      setSubmitError(apiErrorMessage(e, 'Could not save this project.'));
      setSubmitting(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <Screen
        keyboardAvoiding
        header={
          <View className="flex-row items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <Text className="text-base font-semibold text-slate-100">
              {project ? 'Edit project' : 'New project'}
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
              <Text className="text-sm font-medium text-slate-400">Cancel</Text>
            </Pressable>
          </View>
        }
        footer={
          <View className="border-t border-slate-800 px-4 py-3">
            <Button
              label={project ? 'Save project' : 'Create project'}
              onPress={handleSubmit}
              loading={submitting}
              testID="save-project"
            />
          </View>
        }
      >
        <TextField
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="Website rebuild"
          autoCapitalize="sentences"
          error={errors.name}
          hint={
            renaming
              ? 'Renaming updates this project only. Tasks, time entries and past invoices keep the name they were saved with.'
              : undefined
          }
          testID="project-name"
        />

        <Select
          label="Client"
          value={clientId}
          onChange={setClientId}
          options={clientOptions}
          placeholder="Choose a client"
          emptyLabel="No clients yet — create one first."
          error={errors.client}
          hint={
            reparenting
              ? 'Moving this project re-points its tasks and time entries at the new client. Past invoices keep the client they were issued to.'
              : undefined
          }
          testID="project-client"
        />

        <NumberField
          label="Rate"
          value={rate}
          onChangeText={setRate}
          placeholder="Leave empty to inherit"
          suffix={selectedClient?.currency ?? 'USD'}
          error={errors.rate}
          warning={rateInputWarning(rate)}
          hint={describeProjectRate(rate, selectedClient)}
          testID="project-rate"
        />

        {/*
          The explicit way back to "inherit". A backspace on a keypad is the
          only other route from 0 to empty, and those are exactly the two values
          that must not blur together.
        */}
        {rate.trim() !== '' ? (
          <Pressable
            onPress={() => setRate('')}
            hitSlop={8}
            accessibilityRole="button"
            className="-mt-2 self-start"
          >
            <Text className="text-xs font-medium text-violet-400">
              Clear rate — inherit from the client
            </Text>
          </Pressable>
        ) : null}

        {submitError ? <ErrorNote message={submitError} /> : null}
      </Screen>
    </Modal>
  );
}
