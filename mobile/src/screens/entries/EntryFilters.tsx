// Client, project and date-range filters.
//
// All four are applied by the server (`GET /sessions` takes `client_id`,
// `project_id`, `date_from`, `date_to`), so the screen refetches when any of
// them changes rather than filtering a list it already holds.
//
// The two dates are held as **wire timestamps at Singapore midnight** because
// that is what `DateTimeField` speaks; the screen derives the `YYYY-MM-DD` the
// API wants with `sgtDayKey`. Neither this file nor the screen ever reaches for
// `.toISOString().slice(0, 10)`, which returns the previous day for the first
// eight hours of every Singapore day.

import { Text, View } from 'react-native';

import { Button, Card, DateTimeField, Select, type SelectOption } from '@/components';
import type { Client, Project } from '@/types';
import { DEFAULT_WINDOW_DAYS, describeWindow } from './grouping';

export interface EntryFiltersProps {
  clients: Client[];
  projects: Project[];
  clientId: string | null;
  projectId: string | null;
  /** Wire timestamps at Singapore midnight, or `null` for "no bound". */
  from: string | null;
  to: string | null;
  onChangeClient: (value: string | null) => void;
  onChangeProject: (value: string | null) => void;
  onChangeFrom: (value: string | null) => void;
  onChangeTo: (value: string | null) => void;
  onReset: () => void;
}

export default function EntryFilters({
  clients,
  projects,
  clientId,
  projectId,
  from,
  to,
  onChangeClient,
  onChangeProject,
  onChangeFrom,
  onChangeTo,
  onReset,
}: EntryFiltersProps) {
  // Narrowing the client narrows the projects with it, the same as the web.
  const visibleProjects = clientId ? projects.filter((p) => p.client_id === clientId) : projects;

  const clientOptions: SelectOption[] = clients.map((c) => ({ label: c.name, value: c.id }));
  const projectOptions: SelectOption[] = visibleProjects.map((p) => ({
    label: p.name,
    value: p.id,
    sublabel: p.client_name,
  }));

  // A start after its end is the user's call — flagged, never blocked
  // (CLAUDE.md). It simply returns nothing, and saying so beats a silent
  // empty list.
  const inverted = from !== null && to !== null && from > to;

  return (
    <Card className="gap-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Filters
        </Text>
        <Button
          label={`Reset · last ${DEFAULT_WINDOW_DAYS} days`}
          variant="ghost"
          fullWidth={false}
          onPress={onReset}
        />
      </View>

      <Select
        label="Client"
        value={clientId}
        onChange={(value) => onChangeClient(value)}
        options={clientOptions}
        placeholder="All clients"
        noneLabel="All clients"
        title="Filter by client"
        emptyLabel="No clients yet."
      />

      <Select
        label="Project"
        value={projectId}
        onChange={(value) => onChangeProject(value)}
        options={projectOptions}
        placeholder="All projects"
        noneLabel="All projects"
        title="Filter by project"
        emptyLabel={clientId ? 'This client has no projects.' : 'No projects yet.'}
      />

      <View className="flex-row gap-3">
        <View className="flex-1">
          <DateTimeField
            label="From"
            mode="date"
            clearable
            value={from}
            onChange={onChangeFrom}
            placeholder="Any date"
            error={inverted ? 'After the To date.' : undefined}
          />
        </View>
        <View className="flex-1">
          <DateTimeField
            label="To"
            mode="date"
            clearable
            value={to}
            onChange={onChangeTo}
            placeholder="Any date"
          />
        </View>
      </View>

      <Text className="text-xs leading-relaxed text-slate-500">
        Showing {describeWindow(from, to)}. Clear both dates to see everything.
      </Text>
    </Card>
  );
}
