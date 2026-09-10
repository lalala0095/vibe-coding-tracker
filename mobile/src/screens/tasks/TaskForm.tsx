// The full task form. Edits an existing task, or creates a sub-task under one.
//
// `QuickAddSheet` stays what it is — the four-field capture for "log this
// before I forget". This is the other half: everything a task has, including
// the two fields quick-add deliberately omits (description and parent).
//
// ── Clearing conventions ─────────────────────────────────────────────────────
//
// The form emits plain values, exactly as `EntryForm` does: `null` means
// "cleared" for `parent_task_id` and `due_date`. Mapping that onto the wire —
// the literal string `"null"` on update, an omitted key on create — is the
// screen's job, not the form's. See `app/(tabs)/tasks.tsx`.
//
// ── Cycles ───────────────────────────────────────────────────────────────────
//
// `parent_task_id` self-nests and `back/routers/tasks.py` stores whatever it is
// handed, so nothing server-side stops a task becoming its own ancestor. The
// parent picker therefore offers neither the task itself nor any of its
// descendants (`descendantIds`), which is the only place that loop can be
// refused.
//
// ── No locking (CLAUDE.md) ───────────────────────────────────────────────────
//
// Nothing here is read-only. A due date already in the past, or a parent in a
// different project, gets a `warning` and saves exactly as entered. The save
// button's `loading` state is a double-submit guard and the only inert thing on
// the screen.

import { useMemo, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import { apiErrorMessage } from '@/api';
import {
  Button,
  DateTimeField,
  ErrorNote,
  Screen,
  Select,
  TextField,
  type SelectOption,
} from '@/components';
import { parseSgt, sgtDay, todaySgt } from '@/lib/sgt';
import type { Project, Task, TaskPriority, TaskStatus } from '@/types';

import { descendantIds } from './rows';
import { PRIORITY_LABEL, PRIORITY_ORDER, STATUS_LABEL, STATUS_ORDER } from './taskMeta';

/** Plain values. `null` means "cleared" — see the header. */
export interface TaskFormValues {
  title: string;
  description: string;
  project_id: string;
  parent_task_id: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /** A bare `YYYY-MM-DD`, never a timestamp. */
  due_date: string | null;
}

export interface TaskFormProps {
  /** The task being edited, or `null` when creating one. */
  task: Task | null;
  /** Pre-selected parent when creating a sub-task. Ignored when editing. */
  parent: Task | null;
  /** Every loaded task: the parent picker's options and its cycle guard. */
  tasks: Task[];
  projects: Project[];
  /** Throwing surfaces the message in the form and keeps it open. */
  onSubmit: (values: TaskFormValues) => Promise<void>;
  onCancel: () => void;
}

interface FieldErrors {
  title?: string;
  project?: string;
}

export default function TaskForm({
  task,
  parent,
  tasks,
  projects,
  onSubmit,
  onCancel,
}: TaskFormProps) {
  const editing = task !== null;

  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [projectId, setProjectId] = useState<string | null>(
    task?.project_id ?? parent?.project_id ?? null,
  );
  const [parentId, setParentId] = useState<string | null>(
    task ? task.parent_task_id : (parent?.id ?? null),
  );
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium');
  // `DateTimeField` speaks the wire timestamp, but `due_date` is a bare
  // `YYYY-MM-DD`. `parseSgt` reads a bare date as Singapore midnight, so the
  // stored value can be handed to the picker as-is and pulled back out with
  // `sgtDay` on save — never `.toISOString()`, which between midnight and 08:00
  // would hand back yesterday.
  const [dueAt, setDueAt] = useState<string | null>(task?.due_date ?? null);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

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

  // The task itself and everything under it. Choosing any of them would make
  // the task its own ancestor, which the server would store and no reader of
  // the tree could then walk.
  const blockedParents = useMemo<Set<string>>(() => {
    if (!task) return new Set<string>();
    const blocked = descendantIds(tasks, task.id);
    blocked.add(task.id);
    return blocked;
  }, [tasks, task]);

  const parentOptions = useMemo<SelectOption[]>(
    () =>
      tasks
        .filter((candidate) => !blockedParents.has(candidate.id))
        .map((candidate) => ({
          label: candidate.title,
          value: candidate.id,
          sublabel: `${candidate.client_name} / ${candidate.project_name}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tasks, blockedParents],
  );

  const parentTask = useMemo(
    () => (parentId ? (tasks.find((candidate) => candidate.id === parentId) ?? null) : null),
    [tasks, parentId],
  );

  // Three things the picker cannot show on its own, each worth a word rather
  // than a silently blank field.
  const parentWarning = (() => {
    if (parentId === null) return undefined;
    if (blockedParents.has(parentId)) {
      return 'This task is currently nested under one of its own sub-tasks. Pick another parent, or clear it.';
    }
    if (!parentTask) {
      return 'The parent this task points at no longer exists. Clear it to make this a top-level task.';
    }
    if (projectId && parentTask.project_id !== projectId) {
      return 'The parent sits in a different project. Saved as chosen — nothing is moved for you.';
    }
    return undefined;
  })();

  const parsedDue = parseSgt(dueAt);
  const dueDate = parsedDue ? sgtDay(parsedDue) : null;
  const duePast = dueDate !== null && dueDate < todaySgt();

  const handleSubmit = async (): Promise<void> => {
    const next: FieldErrors = {};
    const trimmedTitle = title.trim();

    if (!trimmedTitle) next.title = 'A title is required.';
    if (!projectId) next.project = 'A task needs a project.';

    setErrors(next);
    if (!trimmedTitle || !projectId) return;

    setSubmitError('');
    setSubmitting(true);
    try {
      await onSubmit({
        title: trimmedTitle,
        // An empty description is the cleared state: `description` is a plain
        // string on the wire, not one of the nullable fields, so "" clears it.
        description: description.trim(),
        project_id: projectId,
        parent_task_id: parentId,
        status,
        priority,
        due_date: dueDate,
      });
      // No setSubmitting(false) on success — the caller unmounts this form, and
      // clearing it first flashes the button back to idle.
    } catch (e: unknown) {
      setSubmitError(
        apiErrorMessage(e, editing ? 'Could not save this task.' : 'Could not create that task.'),
      );
      setSubmitting(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      {/* `Screen` already owns the page background, the safe area, the scroll
          body and the pinned header/footer slots — the same reuse `EntryForm`
          makes rather than growing a second layout. */}
      <Screen
        keyboardAvoiding
        header={
          <View className="flex-row items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <Text className="text-base font-semibold text-slate-100">
              {editing ? 'Edit task' : 'New sub-task'}
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
              <Text className="text-sm font-medium text-slate-400">Cancel</Text>
            </Pressable>
          </View>
        }
        footer={
          <View className="border-t border-slate-800 px-4 py-3">
            <Button
              label={editing ? 'Save changes' : 'Create sub-task'}
              onPress={() => void handleSubmit()}
              loading={submitting}
              testID="task-form-submit"
            />
          </View>
        }
      >
        <TextField
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="What needs doing?"
          error={errors.title}
          testID="task-form-title"
        />

        <TextField
          label="Description"
          value={description}
          onChangeText={setDescription}
          placeholder="Anything worth remembering about it"
          multiline
          numberOfLines={4}
          hint="Optional. Clearing it saves an empty description."
          testID="task-form-description"
        />

        <Select
          label="Project"
          value={projectId}
          onChange={setProjectId}
          options={projectOptions}
          placeholder="Choose a project"
          title="Project"
          emptyLabel="No projects yet — add one under Clients."
          error={errors.project}
          hint={
            editing
              ? 'Moving a task to another project moves it to that project’s client too.'
              : undefined
          }
          testID="task-form-project"
        />

        <Select
          label="Parent task"
          value={parentId}
          onChange={setParentId}
          options={parentOptions}
          placeholder="No parent (top-level)"
          noneLabel="No parent (top-level)"
          title="Parent task"
          emptyLabel="No other task can be this one’s parent."
          warning={parentWarning}
          hint={
            editing
              ? 'This task and everything under it are left out of the list — a task cannot be nested inside itself.'
              : undefined
          }
          testID="task-form-parent"
        />

        <View className="flex-row gap-3">
          <View className="flex-1">
            <Select
              label="Status"
              value={status}
              onChange={(value) => setStatus((value as TaskStatus | null) ?? 'todo')}
              options={STATUS_ORDER.map((value) => ({ label: STATUS_LABEL[value], value }))}
              searchable={false}
              title="Status"
              testID="task-form-status"
            />
          </View>
          <View className="flex-1">
            <Select
              label="Priority"
              value={priority}
              onChange={(value) => setPriority((value as TaskPriority | null) ?? 'medium')}
              options={PRIORITY_ORDER.map((value) => ({ label: PRIORITY_LABEL[value], value }))}
              searchable={false}
              title="Priority"
              testID="task-form-priority"
            />
          </View>
        </View>

        <DateTimeField
          label="Due date"
          value={dueAt}
          onChange={setDueAt}
          mode="date"
          clearable
          placeholder="No due date"
          // A date in the past is a fact about the work, not an invalid entry.
          warning={duePast ? 'This due date has already passed. Saved as entered.' : undefined}
          hint="Optional."
          testID="task-form-due"
        />

        {submitError ? <ErrorNote message={submitError} /> : null}
      </Screen>
    </Modal>
  );
}
