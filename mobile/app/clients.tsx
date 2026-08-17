// Clients & Projects — both on one screen, because on a phone they are one
// mental model: a client, with the projects that bill against it underneath.
//
// This file owns the data: the fetches, the mutations and the wire conventions.
// Everything visual lives in `src/screens/clients/`.
//
// ── Three fetches, one of them optional ──────────────────────────────────────
//
// Clients and projects are the screen. Tasks are fetched only to count what a
// delete would strand, so a failure there degrades the confirmation copy from
// "3 tasks" to "its tasks" and is not worth an error banner over the list.
//
// ── The two clearing conventions ─────────────────────────────────────────────
//
// `MyTrackerFormat.md` → "Clearing optional fields on update". They are not
// interchangeable, and the routers show exactly why:
//
//   `default_rate`, `rate`   nullable numeric → a real JSON `null` clears.
//                            `clients.py` / `projects.py` test
//                            `"default_rate" in payload.model_fields_set`, so
//                            presence-with-null is the clear and absence is
//                            "leave alone".
//
//   `billing_email`,         string fields → the literal string `"null"`
//   `billing_address`        clears. `clients.py` tests
//                            `payload.billing_email.lower() == "null"` and
//                            writes `None`; a JSON null would instead fail the
//                            `is not None` guard above it and be ignored.
//
// Swapping them is silent in both directions: a JSON null on `billing_address`
// leaves the old address in place, and the string `"null"` in `default_rate` is
// not a number at all. Worse, the string sentinel is only special on *update* —
// `create_client` writes whatever it is given straight to Firestore, so sending
// `"null"` on create stores the four characters `null` and then prints them in
// an invoice's Bill To. On create, therefore, a blank is simply omitted.
//
// `currency` is a third case and follows neither convention: it is
// non-nullable server-side, so a blank box omits the key and leaves the stored
// value alone. It must never be sent as `"null"`.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import {
  apiErrorMessage,
  createClient,
  createProject,
  deleteClient,
  deleteProject,
  getClients,
  getProjects,
  getTasks,
  updateClient,
  updateProject,
  type ClientOptions,
} from '@/api';
import {
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  ErrorNote,
  LoadingBlock,
  Screen,
} from '@/components';
import ClientCard from '@/screens/clients/ClientCard';
import ClientForm, { type ClientFormValues } from '@/screens/clients/ClientForm';
import { clientDeletionDetail, projectDeletionDetail } from '@/screens/clients/deletion';
import ProjectForm, { type ProjectFormValues } from '@/screens/clients/ProjectForm';
import ProjectRow from '@/screens/clients/ProjectRow';
import type { Client, Project } from '@/types';

/** What the client editor is open on. */
type EditingClient = { mode: 'new' } | { mode: 'edit'; client: Client } | null;

/** What the project editor is open on — `clientId` preselects on create. */
type EditingProject =
  | { mode: 'new'; clientId: string | null }
  | { mode: 'edit'; project: Project }
  | null;

export default function ClientsScreen() {
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Counts only. `null` is "not loaded", which the confirmation copy renders
  // differently from a real zero.
  const [taskCounts, setTaskCounts] = useState<{
    byClient: Record<string, number>;
    byProject: Record<string, number>;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editingClient, setEditingClient] = useState<EditingClient>(null);
  const [editingProject, setEditingProject] = useState<EditingProject>(null);
  // One sheet each for the whole list — the thing it is asking about, not a
  // flag per row.
  const [deleteClientTarget, setDeleteClientTarget] = useState<Client | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null);

  // ── Fetching ───────────────────────────────────────────────────────────────

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    setError('');
    try {
      // `getProjects()` with no argument returns every project, which is one
      // request instead of one per client.
      const [clientList, projectList] = await Promise.all([getClients(), getProjects()]);
      setClients(clientList);
      setProjects(projectList);
    } catch (e: unknown) {
      setError(apiErrorMessage(e, 'Could not load clients and projects.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTaskCounts = useCallback(async () => {
    try {
      const tasks = await getTasks();
      const byClient: Record<string, number> = {};
      const byProject: Record<string, number> = {};
      for (const task of tasks) {
        byClient[task.client_id] = (byClient[task.client_id] ?? 0) + 1;
        byProject[task.project_id] = (byProject[task.project_id] ?? 0) + 1;
      }
      setTaskCounts({ byClient, byProject });
    } catch {
      // Deliberately silent: this only sharpens a delete confirmation, and
      // `deletion.ts` already has copy for the unknown case. An error banner
      // over a list that loaded fine would be noise.
      setTaskCounts(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadTaskCounts();
  }, [loadTaskCounts]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    // Neither rejects — both record their own failure — so nothing here needs a
    // catch to keep the spinner from sticking.
    await Promise.all([load({ silent: true }), loadTaskCounts()]);
    setRefreshing(false);
  }, [load, loadTaskCounts]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const projectsByClient = useMemo(() => {
    const grouped: Record<string, Project[]> = {};
    for (const project of projects) {
      (grouped[project.client_id] ??= []).push(project);
    }
    return grouped;
  }, [projects]);

  // Projects whose client is gone. The server permits exactly this — deleting a
  // client strands its projects — so a list grouped by client has to have
  // somewhere to put them, or they would silently vanish from a screen that is
  // supposed to be honest about the consequence.
  const orphanedProjects = useMemo(() => {
    const known = new Set(clients.map((client) => client.id));
    return projects.filter((project) => !known.has(project.client_id));
  }, [clients, projects]);

  const taskCountFor = (map: 'byClient' | 'byProject', id: string): number | null =>
    taskCounts ? (taskCounts[map][id] ?? 0) : null;

  // ── Mutations ──────────────────────────────────────────────────────────────
  //
  // The clearing conventions are applied here and nowhere else — see the block
  // comment at the top of the file. The forms emit plain values where `null`
  // means "cleared"; translating that into the right sentinel is this layer's
  // job.

  const handleSubmitClient = async (values: ClientFormValues) => {
    if (editingClient?.mode === 'edit') {
      await updateClient(editingClient.client.id, {
        name: values.name,
        // Nullable numeric: the key is always present, so this either sets the
        // rate or clears it. `0` goes out as `0` and stays a real rate.
        default_rate: values.default_rate,
        // String fields: the literal "null" is what clears them on update.
        billing_email: values.billing_email ?? 'null',
        billing_address: values.billing_address ?? 'null',
        // Non-nullable: omitted entirely when blank. Never "null" — it would be
        // stored verbatim and printed on an invoice.
        ...(values.currency ? { currency: values.currency } : {}),
      });
    } else {
      // On create there is nothing to clear, and the "null" sentinel is not
      // honoured by `create_client` anyway — it would be stored as the string.
      // So blanks are omitted and only the numeric null is sent explicitly.
      const options: ClientOptions = { default_rate: values.default_rate };
      if (values.currency) options.currency = values.currency;
      if (values.billing_email) options.billing_email = values.billing_email;
      if (values.billing_address) options.billing_address = values.billing_address;

      await createClient(values.name, options);
    }

    setEditingClient(null);
    await load({ silent: true });
  };

  const handleSubmitProject = async (values: ProjectFormValues) => {
    if (editingProject?.mode === 'edit') {
      await updateProject(editingProject.project.id, {
        name: values.name,
        // Changing this refreshes the denormalised `client_name` server-side.
        client_id: values.client_id,
        // Nullable numeric: always present, so this sets or clears. `null`
        // means "inherit the client default"; `0` is a real rate of zero.
        rate: values.rate,
      });
    } else {
      await createProject(values.name, values.client_id, { rate: values.rate });
    }

    setEditingProject(null);
    // Refetched rather than spliced in: a project moved to another client has
    // to leave one card and appear under another.
    await load({ silent: true });
  };

  // Both throw on failure so `ConfirmSheet` reports it in place and stays open.

  const handleDeleteClient = async (client: Client) => {
    await deleteClient(client.id);
    setClients((prev) => prev.filter((c) => c.id !== client.id));
    // Its projects are deliberately left in state. They are still in the
    // database — the delete does not cascade — and they reappear under
    // "Projects with no client", which is the truth of what just happened.
  };

  const handleDeleteProject = async (project: Project) => {
    await deleteProject(project.id);
    setProjects((prev) => prev.filter((p) => p.id !== project.id));
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const header = (
    <View className="border-b border-slate-800 px-4 pb-3 pt-1">
      <Text className="text-xl font-bold text-slate-100">Clients & Projects</Text>
      <Text className="mt-0.5 text-xs leading-relaxed text-slate-500">
        Who the work is for, and what it bills at. Tap a client to see its projects.
      </Text>
    </View>
  );

  const footer = (
    <View className="border-t border-slate-800 px-4 py-3">
      <Button
        label="+ New client"
        onPress={() => setEditingClient({ mode: 'new' })}
        testID="new-client"
      />
    </View>
  );

  return (
    <Screen header={header} footer={footer} refreshing={refreshing} onRefresh={handleRefresh}>
      {loading ? (
        <LoadingBlock label="Loading clients…" />
      ) : error ? (
        <ErrorNote message={error} onRetry={() => load()} />
      ) : clients.length === 0 && orphanedProjects.length === 0 ? (
        <EmptyState
          title="No clients yet"
          subtitle="A client holds the projects, and a project holds the tasks that time is logged against. Start here."
          actionLabel="New client"
          onAction={() => setEditingClient({ mode: 'new' })}
        />
      ) : (
        <View className="gap-3">
          {clients.map((client) => (
            <ClientCard
              key={client.id}
              client={client}
              projects={projectsByClient[client.id] ?? []}
              expanded={expanded[client.id] ?? false}
              onToggle={() =>
                setExpanded((prev) => ({ ...prev, [client.id]: !(prev[client.id] ?? false) }))
              }
              onEdit={() => setEditingClient({ mode: 'edit', client })}
              onDelete={() => setDeleteClientTarget(client)}
              onAddProject={() => setEditingProject({ mode: 'new', clientId: client.id })}
              onEditProject={(project) => setEditingProject({ mode: 'edit', project })}
              onDeleteProject={setDeleteProjectTarget}
            />
          ))}

          {orphanedProjects.length > 0 ? (
            <View className="gap-2">
              <Text className="px-1 text-xs font-medium uppercase tracking-wide text-amber-400">
                Projects with no client
              </Text>
              <Text className="px-1 text-xs leading-relaxed text-slate-500">
                Their client was deleted. Deleting never cascades, so these are still here and
                still billable — but nothing resolves a rate for them until they are moved to a
                client that exists.
              </Text>
              <Card padded={false}>
                {orphanedProjects.map((project, index) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    client={null}
                    first={index === 0}
                    onEdit={() => setEditingProject({ mode: 'edit', project })}
                    onDelete={() => setDeleteProjectTarget(project)}
                  />
                ))}
              </Card>
            </View>
          ) : null}
        </View>
      )}

      {editingClient ? (
        <ClientForm
          // Remounts when the target changes, so the fields never carry over
          // from the previously edited client.
          key={editingClient.mode === 'edit' ? editingClient.client.id : 'new'}
          client={editingClient.mode === 'edit' ? editingClient.client : null}
          onSubmit={handleSubmitClient}
          onCancel={() => setEditingClient(null)}
        />
      ) : null}

      {editingProject ? (
        <ProjectForm
          key={editingProject.mode === 'edit' ? editingProject.project.id : 'new'}
          project={editingProject.mode === 'edit' ? editingProject.project : null}
          clients={clients}
          defaultClientId={editingProject.mode === 'new' ? editingProject.clientId : null}
          onSubmit={handleSubmitProject}
          onCancel={() => setEditingProject(null)}
        />
      ) : null}

      {deleteClientTarget ? (
        <ConfirmSheet
          open
          title="Delete client"
          message={`Delete ${deleteClientTarget.name}?`}
          detail={clientDeletionDetail(
            deleteClientTarget.name,
            (projectsByClient[deleteClientTarget.id] ?? []).length,
            taskCountFor('byClient', deleteClientTarget.id),
          )}
          onConfirm={() => handleDeleteClient(deleteClientTarget)}
          onClose={() => setDeleteClientTarget(null)}
        />
      ) : null}

      {deleteProjectTarget ? (
        <ConfirmSheet
          open
          title="Delete project"
          message={`Delete ${deleteProjectTarget.name}?`}
          detail={projectDeletionDetail(
            deleteProjectTarget.name,
            taskCountFor('byProject', deleteProjectTarget.id),
          )}
          onConfirm={() => handleDeleteProject(deleteProjectTarget)}
          onClose={() => setDeleteProjectTarget(null)}
        />
      ) : null}
    </Screen>
  );
}
