// One project inside its client's card.
//
// The row's job is to answer "what does this bill at, and is that figure the
// project's own or the client's?" — because an inherited rate and a rate set
// here look identical once they are just a number on a line. `projectRateLabel`
// spells out which, and the chip tone reinforces it: violet for a rate this
// project owns, slate for one it is borrowing, amber when there is no rate to
// be found at any level.

import { Pressable, Text, View } from 'react-native';

import { Chip } from '@/components';
import type { Client, Project } from '@/types';
import { hasOwnRate, projectRateLabel } from './rates';

export interface ProjectRowProps {
  project: Project;
  /**
   * The client it sits under — the source of an inherited rate. `null` when
   * that client has been deleted out from under it, which the server permits.
   */
  client: Client | null;
  /** Suppresses the top hairline on the first row of the group. */
  first: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export default function ProjectRow({
  project,
  client,
  first,
  onEdit,
  onDelete,
}: ProjectRowProps) {
  const own = hasOwnRate(project);
  // Nothing anywhere: the project inherits, and there is no client default to
  // inherit — either because it is unset or because the client is gone.
  const unresolved = !own && (client === null || client.default_rate === null);

  return (
    <View
      className={[
        'flex-row items-center gap-3 px-4 py-3',
        first ? '' : 'border-t border-slate-800/70',
      ].join(' ')}
    >
      <View className="min-w-0 flex-1 gap-1.5">
        <Text className="text-sm font-medium text-slate-100" numberOfLines={2}>
          {project.name}
        </Text>
        <Chip
          label={projectRateLabel(project, client)}
          tone={unresolved ? 'amber' : own ? 'violet' : 'slate'}
        />
      </View>

      <Pressable
        onPress={onEdit}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${project.name}`}
        className="rounded-lg border border-slate-700 px-3 py-1.5 active:bg-slate-800"
      >
        <Text className="text-xs font-medium text-slate-300">Edit</Text>
      </Pressable>

      <Pressable
        onPress={onDelete}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${project.name}`}
        className="rounded-lg border border-red-500/40 px-3 py-1.5 active:bg-red-500/10"
      >
        <Text className="text-xs font-medium text-red-400">Delete</Text>
      </Pressable>
    </View>
  );
}
