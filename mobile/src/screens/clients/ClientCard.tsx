// One client, with its projects folded underneath it.
//
// ── Why one expandable card instead of two panes ─────────────────────────────
//
// The web version is a two-column list-plus-detail: clients on the left,
// projects for the selected client on the right. A phone has one column, and
// splitting the same idea across two pushed screens would mean a round trip to
// answer "what does this client's project actually bill at?".
//
// So the hierarchy is the layout. A collapsed card is one line about the client;
// tapping it reveals its projects and the actions for both levels. Nothing here
// needs horizontal space to read.

import { Pressable, Text, View } from 'react-native';

import { Card, Chip } from '@/components';
import type { Client, Project } from '@/types';
import ProjectRow from './ProjectRow';
import { clientRateLabel } from './rates';

export interface ClientCardProps {
  client: Client;
  /** Already narrowed to this client by the screen. */
  projects: Project[];
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddProject: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
}

export default function ClientCard({
  client,
  projects,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onAddProject,
  onEditProject,
  onDeleteProject,
}: ClientCardProps) {
  // A client with no default rate is the case worth spotting from the list, so
  // it is the one that gets a coloured chip rather than a quiet slate one.
  const rateTone = client.default_rate === null ? 'amber' : 'violet';

  const billing = [
    client.billing_email ? 'Billing email' : null,
    client.billing_address ? 'Billing address' : null,
  ].filter((part): part is string => part !== null);

  return (
    <Card padded={false}>
      {/*
        The whole header row is the toggle. A chevron-sized target is not a
        target; this one is the full width of the card.
      */}
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${client.name}, ${projects.length} projects`}
        className="flex-row items-start gap-3 px-4 py-4 active:bg-slate-800"
      >
        <View className="min-w-0 flex-1 gap-2">
          <Text className="text-base font-semibold text-slate-100" numberOfLines={2}>
            {client.name}
          </Text>

          <View className="flex-row flex-wrap items-center gap-2">
            <Chip label={clientRateLabel(client)} tone={rateTone} />
            <Chip label={client.currency} />
            <Text className="text-xs text-slate-500">
              {projects.length} {projects.length === 1 ? 'project' : 'projects'}
            </Text>
          </View>

          <Text className="text-xs text-slate-500" numberOfLines={1}>
            {billing.length > 0 ? billing.join(' · ') : 'No billing email or address'}
          </Text>
        </View>

        {/* No icon library in this app — glyphs are text characters. */}
        <Text className="pt-0.5 text-lg leading-none text-slate-500">
          {expanded ? '⌄' : '›'}
        </Text>
      </Pressable>

      {expanded ? (
        <View className="border-t border-slate-800">
          <View className="flex-row gap-2 px-4 py-3">
            <Pressable
              onPress={onEdit}
              hitSlop={6}
              accessibilityRole="button"
              className="rounded-lg border border-slate-700 px-3 py-1.5 active:bg-slate-800"
            >
              <Text className="text-xs font-medium text-slate-300">Edit client</Text>
            </Pressable>
            <Pressable
              onPress={onDelete}
              hitSlop={6}
              accessibilityRole="button"
              className="rounded-lg border border-red-500/40 px-3 py-1.5 active:bg-red-500/10"
            >
              <Text className="text-xs font-medium text-red-400">Delete</Text>
            </Pressable>
          </View>

          <View className="border-t border-slate-800/70">
            {projects.length === 0 ? (
              <Text className="px-4 py-4 text-xs leading-relaxed text-slate-500">
                No projects yet. Time is logged against tasks, and every task belongs to a
                project, so this client needs one before any of its work can be tracked.
              </Text>
            ) : (
              projects.map((project, index) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  client={client}
                  first={index === 0}
                  onEdit={() => onEditProject(project)}
                  onDelete={() => onDeleteProject(project)}
                />
              ))
            )}
          </View>

          <Pressable
            onPress={onAddProject}
            accessibilityRole="button"
            className="border-t border-slate-800 px-4 py-3 active:bg-slate-800"
          >
            <Text className="text-sm font-medium text-blue-400">+ Add project</Text>
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}
