// A task's projects: an ordered multi-select, used by the full form and by
// quick-add.
//
// A task links to one or more projects. The first one is the **primary** — the
// project tracker time prices through, and the one a new time entry defaults
// to. So the list is ordered, the first row is badged, and any other row can
// be promoted. Adding goes through the ordinary `Select` (its sheet, its filter
// box) with the already-chosen projects left out.
//
// Removing a project is never blocked here (CLAUDE.md § no locking). If time
// entries on the task still use it, the server answers 409 with a message that
// names the project and the count, and the form shows it verbatim.

import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Chip, FieldFrame, Select, type FieldNotes, type SelectOption } from '@/components';
import type { Project, TaskProjectRef } from '@/types';

export interface ProjectsFieldProps extends FieldNotes {
  label?: string;
  /** Ordered; `[0]` is the primary. */
  value: string[];
  onChange: (next: string[]) => void;
  projects: Project[];
  /**
   * Names for ids no longer in `projects` (a deleted project still linked to
   * the task) — the task's own denormalised `projects`, when editing.
   */
  known?: TaskProjectRef[];
  emptyLabel?: string;
  testID?: string;
}

export default function ProjectsField({
  label = 'Projects',
  value,
  onChange,
  projects,
  known = [],
  emptyLabel = 'No projects yet — add one under Clients.',
  error,
  warning,
  hint,
  testID,
}: ProjectsFieldProps) {
  const describe = (id: string): { name: string; client: string } => {
    const project = projects.find((candidate) => candidate.id === id);
    if (project) return { name: project.name, client: project.client_name };
    const ref = known.find((candidate) => candidate.project_id === id);
    if (ref) return { name: ref.project_name, client: ref.client_name };
    return { name: 'Project no longer exists', client: '' };
  };

  const addOptions = useMemo<SelectOption[]>(
    () =>
      projects
        .filter((project) => !value.includes(project.id))
        .map((project) => ({
          label: project.name,
          value: project.id,
          sublabel: project.client_name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [projects, value],
  );

  const remove = (id: string) => onChange(value.filter((candidate) => candidate !== id));
  const makePrimary = (id: string) =>
    onChange([id, ...value.filter((candidate) => candidate !== id)]);
  const add = (id: string | null) => {
    if (id && !value.includes(id)) onChange([...value, id]);
  };

  return (
    <FieldFrame label={label} error={error} warning={warning} hint={hint}>
      {value.length > 0 ? (
        <View className="overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
          {value.map((id, index) => {
            const { name, client } = describe(id);
            const primary = index === 0;
            return (
              <View
                key={id}
                className={`flex-row items-center gap-2 px-3 py-2.5 ${
                  index > 0 ? 'border-t border-slate-800' : ''
                }`}
                testID={testID ? `${testID}-row-${index}` : undefined}
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-base text-slate-100" numberOfLines={1}>
                    {name}
                  </Text>
                  {client ? (
                    <Text className="text-xs text-slate-500" numberOfLines={1}>
                      {client}
                    </Text>
                  ) : null}
                </View>
                {primary ? (
                  <Chip label="Primary" tone="violet" />
                ) : (
                  <Pressable
                    onPress={() => makePrimary(id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Make ${name} the primary project`}
                  >
                    <Text className="text-xs font-medium text-violet-400">Make primary</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => remove(id)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${name}`}
                >
                  <Text className="px-1 text-base text-slate-500">✕</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}

      <Select
        value={null}
        onChange={add}
        options={addOptions}
        placeholder={value.length === 0 ? 'Choose a project' : '+ Add another project'}
        title="Add a project"
        emptyLabel={projects.length === 0 ? emptyLabel : 'Every project is already linked.'}
        testID={testID ? `${testID}-add` : undefined}
      />
    </FieldFrame>
  );
}
