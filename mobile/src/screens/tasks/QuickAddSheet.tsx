// Quick-add: the "in the moment" capture, deliberately not the web's 397-line
// `TaskForm`.
//
// Title and project are the whole requirement; priority and due date are there
// because they cost one tap each. No description, no attachments (v1 uploads no
// files), no parent picker — sub-tasks are shown, not created here. Pasting a
// list of tasks belongs to the tracker's Add-tasks flow and lives there only,
// so the one paste parser stays behind one UI.

import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import { apiErrorMessage } from '@/api';
import { Button, DateTimeField, Select, TextField, type SelectOption } from '@/components';
import { parseSgt, sgtDay } from '@/lib/sgt';
import type { CreateTaskPayload, Project, TaskPriority } from '@/types';

import { PRIORITY_LABEL, PRIORITY_ORDER } from './taskMeta';

export interface QuickAddSheetProps {
  open: boolean;
  projects: Project[];
  /** Pre-selected project — whatever the list is currently filtered to. */
  defaultProjectId: string | null;
  onClose: () => void;
  /** Throws on failure; the sheet keeps itself open and shows the message. */
  onCreate: (payload: CreateTaskPayload) => Promise<void>;
}

export default function QuickAddSheet({
  open,
  projects,
  defaultProjectId,
  onClose,
  onCreate,
}: QuickAddSheetProps) {
  const { height } = useWindowDimensions();

  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [priority, setPriority] = useState<TaskPriority>('medium');
  // The picker speaks the wire timestamp format; `due_date` is the calendar
  // date pulled back out of it on save.
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Validation stays quiet until the first submit — a form that turns red
  // before you have typed anything is nagging, not helping.
  const [attempted, setAttempted] = useState(false);

  // Each open is a fresh capture; a stale half-typed title from last time is
  // never what you meant to log.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setProjectId(defaultProjectId);
    setPriority('medium');
    setDueAt(null);
    setSubmitting(false);
    setError('');
    setAttempted(false);
  }, [open, defaultProjectId]);

  const projectOptions = useMemo<SelectOption[]>(
    () =>
      projects
        .map((project) => ({
          label: project.name,
          value: project.id,
          sublabel: project.client_name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [projects],
  );

  const priorityOptions = useMemo<SelectOption[]>(
    () => PRIORITY_ORDER.map((value) => ({ label: PRIORITY_LABEL[value], value })),
    [],
  );

  const trimmedTitle = title.trim();

  const handleSubmit = async (): Promise<void> => {
    setAttempted(true);
    if (!trimmedTitle || !projectId) return;

    // `sgtDay` on the parsed instant, never `.toISOString().slice(0, 10)`:
    // between midnight and 08:00 the UTC form is the previous day, and a due
    // date that quietly slips a day is exactly the bug `lib/sgt.ts` exists for.
    const parsedDue = parseSgt(dueAt);
    const dueDate = parsedDue ? sgtDay(parsedDue) : undefined;

    setSubmitting(true);
    setError('');
    try {
      await onCreate({
        title: trimmedTitle,
        project_id: projectId,
        status: 'todo',
        priority,
        ...(dueDate ? { due_date: dueDate } : {}),
      });
      // No setSubmitting(false) on success — the caller closes us, and
      // clearing it first flashes the button back to idle.
      onClose();
    } catch (e: unknown) {
      setError(apiErrorMessage(e, 'Could not create that task.'));
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      {/* Backdrop stays live while submitting, matching ConfirmSheet: a request
          in flight is not a reason to trap someone in a sheet. */}
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        <Pressable
          onPress={() => {}}
          className="rounded-t-2xl border-t border-slate-800 bg-slate-900"
          style={{ maxHeight: height * 0.9 }}
          testID="task-quick-add"
        >
          <View className="border-b border-slate-800 px-5 py-4">
            <Text className="text-base font-semibold text-slate-100">New task</Text>
          </View>

          <ScrollView className="px-5 py-4" keyboardShouldPersistTaps="handled">
            <View className="gap-4">
              <TextField
                label="Title"
                value={title}
                onChangeText={setTitle}
                placeholder="What needs doing?"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => void handleSubmit()}
                error={attempted && !trimmedTitle ? 'A title is required.' : undefined}
                testID="task-quick-add-title"
              />

              <Select
                label="Project"
                value={projectId}
                onChange={setProjectId}
                options={projectOptions}
                placeholder="Choose a project"
                title="Project"
                emptyLabel="No projects yet — add one on the web."
                error={attempted && !projectId ? 'A task needs a project.' : undefined}
                testID="task-quick-add-project"
              />

              <Select
                label="Priority"
                value={priority}
                onChange={(value) => setPriority((value as TaskPriority | null) ?? 'medium')}
                options={priorityOptions}
                searchable={false}
                title="Priority"
                testID="task-quick-add-priority"
              />

              <DateTimeField
                label="Due date"
                value={dueAt}
                onChange={setDueAt}
                mode="date"
                clearable
                placeholder="No due date"
                hint="Optional."
                testID="task-quick-add-due"
              />

              {error ? (
                <View className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2">
                  <Text className="text-sm text-red-400">{error}</Text>
                </View>
              ) : null}
            </View>
          </ScrollView>

          <View className="flex-row gap-3 border-t border-slate-800 px-5 py-4">
            <View className="flex-1">
              <Button label="Cancel" onPress={onClose} variant="secondary" disabled={submitting} />
            </View>
            <View className="flex-1">
              {/* `loading` is the double-submit guard — the only thing on this
                  sheet that ever goes inert. No field does. */}
              <Button
                label="Add task"
                onPress={() => void handleSubmit()}
                loading={submitting}
                testID="task-quick-add-submit"
              />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
