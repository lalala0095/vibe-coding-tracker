// Two ways to put work into the running block, in one sheet.
//
//   Pick existing — filter by project, tick tasks, add them.
//   Paste new     — paste a list, check what the parser made of it, create them
//                   and add them in one go.
//
// The web's version of this is a client → project sidebar beside a recursive
// task tree. On a phone that is a project `Select` and a flat list: sub-tasks
// are shown as ordinary rows rather than nested, because a tree with a
// disclosure triangle at 6 inches costs more than it explains.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { apiErrorMessage, getTasks } from '@/api';
import { Button, ErrorNote, LoadingBlock, Select, TextField, type SelectOption } from '@/components';
import { parseTaskList } from '@/lib/taskPaste';
import type { Project, Task, Tracker } from '@/types';

import Sheet from './Sheet';

type Mode = 'pick' | 'paste';

export interface AddTasksSheetProps {
  open: boolean;
  tracker: Tracker;
  projects: Project[];
  onClose: () => void;
  onAdd: (taskIds: string[]) => Promise<void>;
  /** Creates the tasks, then attaches them. Both calls have to land. */
  onCreate: (projectId: string, titles: string[]) => Promise<void>;
}

export default function AddTasksSheet({
  open,
  tracker,
  projects,
  onClose,
  onAdd,
  onCreate,
}: AddTasksSheetProps) {
  const [mode, setMode] = useState<Mode>('pick');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Pick existing ──
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  // ── Paste new ──
  const [pasteProjectId, setPasteProjectId] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  // The parsed result, kept separately from the pasted text so every title stays
  // editable — the splitter can guess wrong, and a wrong guess should cost an
  // edit rather than a re-paste.
  const [titles, setTitles] = useState<string[]>([]);

  const alreadyOn = useMemo(
    () => new Set(tracker.tasks.map((t) => t.task_id)),
    [tracker.tasks],
  );

  const projectOptions: SelectOption[] = useMemo(
    () =>
      projects.map((project) => ({
        label: project.name,
        value: project.id,
        sublabel: project.client_name,
      })),
    [projects],
  );

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setTasks(await getTasks(projectId ? { project_id: projectId } : undefined));
    } catch (e) {
      setLoadError(apiErrorMessage(e, 'Could not load tasks.'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const visibleTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter(
      (task) =>
        task.title.toLowerCase().includes(needle) ||
        task.project_name.toLowerCase().includes(needle),
    );
  }, [tasks, query]);

  const filledTitles = useMemo(
    () => titles.map((title) => title.trim()).filter(Boolean),
    [titles],
  );

  function toggle(taskId: string) {
    if (alreadyOn.has(taskId)) return;
    setSelected((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId],
    );
  }

  function handlePasteChange(text: string) {
    setPasteText(text);
    setTitles(parseTaskList(text));
  }

  async function handleAdd() {
    if (selected.length === 0) return;
    setSaving(true);
    setError('');
    try {
      await onAdd(selected);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not add the tasks. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  // The sheet stays open on any failure: tasks created but never attached would
  // be invisible from here, so a half-done run has to be visible.
  async function handleCreate() {
    if (!pasteProjectId || filledTitles.length === 0) return;
    setSaving(true);
    setError('');
    try {
      await onCreate(pasteProjectId, filledTitles);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not create the tasks. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      title="Add tasks to this block"
      onClose={onClose}
      footer={
        <>
          {error ? <Text className="text-xs text-red-400">{error}</Text> : null}
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button label="Cancel" variant="secondary" onPress={onClose} />
            </View>
            <View className="flex-1">
              {mode === 'pick' ? (
                <Button
                  label={selected.length > 0 ? `Add (${selected.length})` : 'Add'}
                  loading={saving}
                  disabled={selected.length === 0}
                  onPress={handleAdd}
                />
              ) : (
                <Button
                  label={filledTitles.length > 0 ? `Create (${filledTitles.length})` : 'Create'}
                  loading={saving}
                  disabled={!pasteProjectId || filledTitles.length === 0}
                  onPress={handleCreate}
                />
              )}
            </View>
          </View>
        </>
      }
    >
      {/* Mode tabs */}
      <View className="flex-row gap-2">
        {(
          [
            ['pick', 'Pick existing'],
            ['paste', 'Paste new'],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            onPress={() => {
              setMode(value);
              setError('');
            }}
            accessibilityRole="button"
            className={`rounded-lg px-3 py-2 ${
              mode === value ? 'bg-slate-800' : 'bg-transparent active:bg-slate-800/50'
            }`}
          >
            <Text
              className={`text-sm font-medium ${
                mode === value ? 'text-slate-100' : 'text-slate-400'
              }`}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {mode === 'pick' ? (
        <>
          <Select
            label="Project"
            value={projectId}
            onChange={setProjectId}
            options={projectOptions}
            noneLabel="All projects"
            placeholder="All projects"
            emptyLabel="No projects yet. They are created on the web."
          />

          <TextField
            label="Filter"
            value={query}
            onChangeText={setQuery}
            placeholder="Search titles…"
            autoCapitalize="none"
            autoCorrect={false}
          />

          {loading ? (
            <LoadingBlock label="Loading tasks…" />
          ) : loadError ? (
            <ErrorNote message={loadError} onRetry={fetchTasks} />
          ) : visibleTasks.length === 0 ? (
            <Text className="py-6 text-center text-sm text-slate-500">
              {query.trim() ? 'No task matches that.' : 'No tasks here yet — paste some instead.'}
            </Text>
          ) : (
            <View>
              {visibleTasks.map((task) => {
                const isOn = alreadyOn.has(task.id);
                const isSelected = selected.includes(task.id);
                return (
                  <Pressable
                    key={task.id}
                    onPress={() => toggle(task.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected || isOn }}
                    className="flex-row items-center gap-3 border-b border-slate-800/70 py-3 active:bg-slate-800/40"
                  >
                    <Text
                      className={`w-5 text-center text-base ${
                        isOn ? 'text-slate-600' : isSelected ? 'text-violet-400' : 'text-slate-600'
                      }`}
                    >
                      {isOn || isSelected ? '✓' : '○'}
                    </Text>
                    <View className="flex-1">
                      <Text
                        className={`text-sm ${isOn ? 'text-slate-500' : 'text-slate-100'}`}
                        numberOfLines={2}
                      >
                        {task.title}
                        {isOn ? '  (already added)' : ''}
                      </Text>
                      <Text className="text-xs text-slate-500" numberOfLines={1}>
                        {[task.project_name, task.client_name].filter(Boolean).join(' · ') || '—'}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </>
      ) : (
        <>
          <Select
            label="Project"
            value={pasteProjectId}
            onChange={setPasteProjectId}
            options={projectOptions}
            placeholder="Choose a project"
            emptyLabel="No projects yet. They are created on the web."
            hint="Required — a new task cannot exist without a project."
            error={
              !pasteProjectId && filledTitles.length > 0
                ? 'Choose the project these tasks belong to.'
                : undefined
            }
          />

          <TextField
            label="Paste your list"
            value={pasteText}
            onChangeText={handlePasteChange}
            placeholder={'One per line, tab-separated, or a paragraph of sentences.'}
            multiline
            numberOfLines={5}
            autoCapitalize="none"
          />

          {titles.length > 0 ? (
            <View className="gap-2">
              <Text className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {filledTitles.length} task{filledTitles.length === 1 ? '' : 's'} ready
              </Text>
              <Text className="text-xs text-slate-500">
                Every title is editable — clear one to drop it.
              </Text>
              {titles.map((title, index) => (
                <View key={index} className="flex-row items-center gap-2">
                  <View className="flex-1">
                    <TextField
                      value={title}
                      onChangeText={(next) =>
                        setTitles((prev) => prev.map((t, i) => (i === index ? next : t)))
                      }
                    />
                  </View>
                  <Pressable
                    onPress={() => setTitles((prev) => prev.filter((_, i) => i !== index))}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove "${title}"`}
                  >
                    <Text className="px-1 text-base text-slate-500">✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : pasteText.trim() ? (
            <Text className="text-sm text-slate-500">
              Nothing recognisable in that yet.
            </Text>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
