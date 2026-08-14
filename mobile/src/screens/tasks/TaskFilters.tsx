// The filter bar: client, project, status.
//
// Client and project are `Select`s because the lists are long and searchable.
// Status is four chips rather than a fifth sheet — it has exactly four values,
// and one tap beats open-scroll-tap for something you switch this often.

import { useMemo } from 'react';
import { Text, View } from 'react-native';

import { Chip, Select, type SelectOption } from '@/components';
import type { Client, Project } from '@/types';

import type { StatusFilter } from './rows';
import { STATUS_LABEL, STATUS_ORDER, STATUS_TONE } from './taskMeta';

export interface TaskFiltersProps {
  clients: Client[];
  projects: Project[];
  clientId: string | null;
  projectId: string | null;
  status: StatusFilter;
  onClientChange: (value: string | null) => void;
  onProjectChange: (value: string | null) => void;
  onStatusChange: (value: StatusFilter) => void;
}

const STATUS_FILTERS: StatusFilter[] = ['all', ...STATUS_ORDER];

function statusLabel(value: StatusFilter): string {
  return value === 'all' ? 'All' : STATUS_LABEL[value];
}

export default function TaskFilters({
  clients,
  projects,
  clientId,
  projectId,
  status,
  onClientChange,
  onProjectChange,
  onStatusChange,
}: TaskFiltersProps) {
  const clientOptions = useMemo<SelectOption[]>(
    () =>
      clients
        .map((client) => ({ label: client.name, value: client.id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [clients],
  );

  // Picking a client narrows the project sheet to that client's projects —
  // the sidebar hierarchy from the web, folded into two controls.
  const projectOptions = useMemo<SelectOption[]>(
    () =>
      projects
        .filter((project) => !clientId || project.client_id === clientId)
        .map((project) => ({
          label: project.name,
          value: project.id,
          sublabel: project.client_name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [projects, clientId],
  );

  return (
    <View className="gap-3">
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Select
            label="Client"
            value={clientId}
            onChange={onClientChange}
            options={clientOptions}
            placeholder="All clients"
            noneLabel="All clients"
            title="Filter by client"
            testID="tasks-filter-client"
          />
        </View>
        <View className="flex-1">
          <Select
            label="Project"
            value={projectId}
            onChange={onProjectChange}
            options={projectOptions}
            placeholder="All projects"
            noneLabel="All projects"
            title="Filter by project"
            emptyLabel="No projects for this client."
            testID="tasks-filter-project"
          />
        </View>
      </View>

      <View className="gap-1.5">
        <Text className="text-xs font-medium text-slate-400">Status</Text>
        <View className="flex-row flex-wrap gap-2">
          {STATUS_FILTERS.map((value) => {
            const active = value === status;
            return (
              <Chip
                key={value}
                label={statusLabel(value)}
                size="md"
                // The active filter is the coloured one; the rest recede.
                tone={active ? (value === 'all' ? 'violet' : STATUS_TONE[value]) : 'slate'}
                className={active ? '' : 'opacity-60'}
                onPress={() => onStatusChange(value)}
                testID={`tasks-filter-status-${value}`}
              />
            );
          })}
        </View>
      </View>
    </View>
  );
}
