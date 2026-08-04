import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  getClients, createClient, updateClient, deleteClient,
  getProjects, createProject, updateProject, deleteProject,
} from '../api';
import type { ClientOptions } from '../api';
import type { Client, Project } from '../types';
import AppNav from '../components/AppNav';

// ── Rate helpers ─────────────────────────────────────────────────────────────

// An empty rate input means "inherit" and must be sent as an explicit null.
// 0 is a real rate and must survive as 0 — never conflate the two.
function parseRateInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return Number(trimmed);
}

// Returns a message when the input is present but unusable, '' when it is fine.
// An empty input is always valid — it clears the rate.
//
// A negative rate is NOT an error: neither clients.py nor projects.py validates
// sign, and a negative rate is the natural way to express a credit. Per §1 the
// frontend warns rather than blocks — see rateInputWarning.
function rateInputError(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return `${label} must be a number.`;
  return '';
}

// Non-blocking: shown beside the field, never gates the save.
function rateInputWarning(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed) && parsed < 0) {
    return 'Negative rate — this will subtract on an invoice.';
  }
  return '';
}

// A rate input holds '' for null and the plain number otherwise — 0 renders as "0".
function rateToInput(rate: number | null): string {
  return rate === null ? '' : String(rate);
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-SG', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
    }).format(amount);
  } catch {
    // Currency is free text, so an unknown code must not blow up the list.
    return `${currency} ${amount.toFixed(2)}`;
  }
}

// ── Inline edit drafts ───────────────────────────────────────────────────────

interface ClientDraft {
  name: string;
  default_rate: string;
  currency: string;
  billing_email: string;
  billing_address: string;
}

interface ProjectDraft {
  name: string;
  rate: string;
}

export default function ClientsProjectsPage() {
  // Clients state
  const [clients, setClients] = useState<Client[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsError, setClientsError] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [newClientRate, setNewClientRate] = useState('');
  const [newClientCurrency, setNewClientCurrency] = useState('USD');
  const [newClientEmail, setNewClientEmail] = useState('');
  const [newClientAddress, setNewClientAddress] = useState('');
  const [addingClient, setAddingClient] = useState(false);
  const [addClientError, setAddClientError] = useState('');
  const [confirmDeleteClientId, setConfirmDeleteClientId] = useState<string | null>(null);
  const [deletingClientId, setDeletingClientId] = useState<string | null>(null);
  const [editClientId, setEditClientId] = useState<string | null>(null);
  const [clientDraft, setClientDraft] = useState<ClientDraft | null>(null);
  const [savingClientId, setSavingClientId] = useState<string | null>(null);
  const [editClientError, setEditClientError] = useState('');

  // Projects state
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectClientId, setNewProjectClientId] = useState('');
  const [newProjectRate, setNewProjectRate] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState('');
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [editProjectId, setEditProjectId] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null);
  const [savingProjectId, setSavingProjectId] = useState<string | null>(null);
  const [editProjectError, setEditProjectError] = useState('');

  const fetchClients = useCallback(async () => {
    setClientsLoading(true);
    setClientsError('');
    try {
      const data = await getClients();
      data.sort(
        (a, b) => new Date(a.datetime_inserted).getTime() - new Date(b.datetime_inserted).getTime()
      );
      setClients(data);
    } catch {
      setClientsError('Failed to load clients.');
    } finally {
      setClientsLoading(false);
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError('');
    try {
      const data = await getProjects();
      data.sort(
        (a, b) => new Date(a.datetime_inserted).getTime() - new Date(b.datetime_inserted).getTime()
      );
      setProjects(data);
    } catch {
      setProjectsError('Failed to load projects.');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClients();
    fetchProjects();
  }, [fetchClients, fetchProjects]);

  // Set first client as default when clients load
  useEffect(() => {
    if (clients.length > 0 && !newProjectClientId) {
      setNewProjectClientId(clients[0].id);
    }
  }, [clients, newProjectClientId]);

  // ── Client handlers ────────────────────────────────────────────────────────

  const handleAddClient = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddClientError('');
    const name = newClientName.trim();
    if (!name) {
      setAddClientError('Client name cannot be empty.');
      return;
    }
    const rateError = rateInputError(newClientRate, 'Default rate');
    if (rateError) {
      setAddClientError(rateError);
      return;
    }
    // Empty rate → explicit null. Blank optional strings are simply omitted on
    // create; the "null" sentinel is only meaningful on update.
    const options: ClientOptions = { default_rate: parseRateInput(newClientRate) };
    const currency = newClientCurrency.trim();
    if (currency) options.currency = currency;
    const email = newClientEmail.trim();
    if (email) options.billing_email = email;
    const address = newClientAddress.trim();
    if (address) options.billing_address = address;

    setAddingClient(true);
    try {
      const created = await createClient(name, options);
      setClients((prev) => [...prev, created]);
      setNewClientName('');
      setNewClientRate('');
      setNewClientCurrency('USD');
      setNewClientEmail('');
      setNewClientAddress('');
      // Auto-select new client for project form
      setNewProjectClientId(created.id);
    } catch {
      setAddClientError('Failed to create client. Please try again.');
    } finally {
      setAddingClient(false);
    }
  };

  const startEditClient = (client: Client) => {
    setConfirmDeleteClientId(null);
    setEditClientError('');
    setEditClientId(client.id);
    setClientDraft({
      name: client.name,
      default_rate: rateToInput(client.default_rate),
      currency: client.currency,
      billing_email: client.billing_email ?? '',
      billing_address: client.billing_address ?? '',
    });
  };

  const cancelEditClient = () => {
    setEditClientId(null);
    setClientDraft(null);
    setEditClientError('');
  };

  const handleSaveClient = async (e: React.FormEvent, id: string) => {
    e.preventDefault();
    if (!clientDraft) return;
    setEditClientError('');
    const name = clientDraft.name.trim();
    if (!name) {
      setEditClientError('Client name cannot be empty.');
      return;
    }
    const rateError = rateInputError(clientDraft.default_rate, 'Default rate');
    if (rateError) {
      setEditClientError(rateError);
      return;
    }
    // default_rate: '' → null clears it, '0' → 0 is kept as a real rate.
    // billing_email / billing_address are strings, so they clear with "null".
    const payload: { name?: string } & ClientOptions = {
      name,
      default_rate: parseRateInput(clientDraft.default_rate),
      billing_email: clientDraft.billing_email.trim() || 'null',
      billing_address: clientDraft.billing_address.trim() || 'null',
    };
    const currency = clientDraft.currency.trim();
    // currency is non-nullable — a blank field leaves the stored value alone.
    if (currency) payload.currency = currency;

    setSavingClientId(id);
    try {
      const updated = await updateClient(id, payload);
      setClients((prev) => prev.map((c) => (c.id === id ? updated : c)));
      cancelEditClient();
    } catch {
      setEditClientError('Failed to save client. Please try again.');
    } finally {
      setSavingClientId(null);
    }
  };

  const handleDeleteClient = async (id: string) => {
    setDeletingClientId(id);
    try {
      await deleteClient(id);
      setClients((prev) => prev.filter((c) => c.id !== id));
      setConfirmDeleteClientId(null);
      // Also remove projects that belonged to this client
      setProjects((prev) => prev.filter((p) => p.client_id !== id));
    } catch {
      // silently reset
    } finally {
      setDeletingClientId(null);
    }
  };

  // ── Project handlers ───────────────────────────────────────────────────────

  const handleAddProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddProjectError('');
    const name = newProjectName.trim();
    if (!name) {
      setAddProjectError('Project name cannot be empty.');
      return;
    }
    if (!newProjectClientId) {
      setAddProjectError('Please select a client.');
      return;
    }
    const rateError = rateInputError(newProjectRate, 'Rate');
    if (rateError) {
      setAddProjectError(rateError);
      return;
    }
    setAddingProject(true);
    try {
      // Empty rate → explicit null, meaning "inherit the client default".
      const created = await createProject(name, newProjectClientId, {
        rate: parseRateInput(newProjectRate),
      });
      setProjects((prev) => [...prev, created]);
      setNewProjectName('');
      setNewProjectRate('');
    } catch {
      setAddProjectError('Failed to create project. Please try again.');
    } finally {
      setAddingProject(false);
    }
  };

  const startEditProject = (project: Project) => {
    setConfirmDeleteProjectId(null);
    setEditProjectError('');
    setEditProjectId(project.id);
    setProjectDraft({ name: project.name, rate: rateToInput(project.rate) });
  };

  const cancelEditProject = () => {
    setEditProjectId(null);
    setProjectDraft(null);
    setEditProjectError('');
  };

  const handleSaveProject = async (e: React.FormEvent, id: string) => {
    e.preventDefault();
    if (!projectDraft) return;
    setEditProjectError('');
    const name = projectDraft.name.trim();
    if (!name) {
      setEditProjectError('Project name cannot be empty.');
      return;
    }
    const rateError = rateInputError(projectDraft.rate, 'Rate');
    if (rateError) {
      setEditProjectError(rateError);
      return;
    }
    setSavingProjectId(id);
    try {
      // '' → null falls back to the client default; '0' → 0 is a real zero rate.
      const updated = await updateProject(id, { name, rate: parseRateInput(projectDraft.rate) });
      setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
      cancelEditProject();
    } catch {
      setEditProjectError('Failed to save project. Please try again.');
    } finally {
      setSavingProjectId(null);
    }
  };

  const handleDeleteProject = async (id: string) => {
    setDeletingProjectId(id);
    try {
      await deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setConfirmDeleteProjectId(null);
    } catch {
      // silently reset
    } finally {
      setDeletingProjectId(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950">
      <AppNav active="manage" />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* ── Page heading ── */}
        <div className="mb-8">
          <div className="flex items-center gap-2 text-sm text-slate-500 mb-3">
            <Link to="/tasks" className="hover:text-slate-300 transition-colors">
              Tasks
            </Link>
            <span>/</span>
            <span className="text-slate-300">Clients &amp; Projects</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100">Clients &amp; Projects</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Manage clients and their projects. Tasks are grouped under projects.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Clients column ── */}
          <div className="flex flex-col gap-6">
            {/* Add client form */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <h2 className="text-base font-semibold text-slate-100 mb-4">Add Client</h2>
              <form onSubmit={handleAddClient} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="client-name" className="text-sm font-medium text-slate-300">
                    Client Name
                  </label>
                  <input
                    id="client-name"
                    type="text"
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    disabled={addingClient}
                    placeholder="e.g. Acme Corp"
                    className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                               text-sm placeholder:text-slate-500
                               focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                               disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="client-rate" className="text-sm font-medium text-slate-300">
                      Default Rate
                    </label>
                    <input
                      id="client-rate"
                      type="number"
                      step="0.01"
                      value={newClientRate}
                      onChange={(e) => setNewClientRate(e.target.value)}
                      placeholder="e.g. 85"
                      className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                 text-sm placeholder:text-slate-500
                                 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                    />
                    <p className="text-xs text-slate-500">Per hour. Leave blank for no default.</p>
                    {rateInputWarning(newClientRate) && (
                      <p className="text-xs text-amber-400">{rateInputWarning(newClientRate)}</p>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="client-currency" className="text-sm font-medium text-slate-300">
                      Currency
                    </label>
                    <input
                      id="client-currency"
                      type="text"
                      value={newClientCurrency}
                      onChange={(e) => setNewClientCurrency(e.target.value)}
                      placeholder="USD"
                      className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                 text-sm placeholder:text-slate-500
                                 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="client-email" className="text-sm font-medium text-slate-300">
                    Billing Email
                  </label>
                  <input
                    id="client-email"
                    type="email"
                    value={newClientEmail}
                    onChange={(e) => setNewClientEmail(e.target.value)}
                    placeholder="billing@acme.com"
                    className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                               text-sm placeholder:text-slate-500
                               focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="client-address" className="text-sm font-medium text-slate-300">
                    Billing Address
                  </label>
                  <textarea
                    id="client-address"
                    rows={3}
                    value={newClientAddress}
                    onChange={(e) => setNewClientAddress(e.target.value)}
                    placeholder={'123 Example Rd\nSingapore 123456'}
                    className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                               text-sm placeholder:text-slate-500 resize-y
                               focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  />
                </div>

                {addClientError && (
                  <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                    {addClientError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={addingClient}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium
                             text-white bg-violet-600 rounded-lg hover:bg-violet-500 transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {addingClient && (
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  {addingClient ? 'Adding…' : 'Add Client'}
                </button>
              </form>
            </div>

            {/* Clients list */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-800">
                <h2 className="text-base font-semibold text-slate-100">
                  Clients
                  {!clientsLoading && (
                    <span className="ml-2 text-sm font-normal text-slate-500">
                      ({clients.length})
                    </span>
                  )}
                </h2>
              </div>

              {clientsLoading ? (
                <div className="flex items-center justify-center py-12 gap-3">
                  <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-slate-400 text-sm">Loading clients…</p>
                </div>
              ) : clientsError ? (
                <div className="flex flex-col items-center py-12 gap-3 text-center px-6">
                  <p className="text-red-400 text-sm">{clientsError}</p>
                  <button
                    onClick={fetchClients}
                    className="text-sm text-violet-400 hover:text-violet-300 underline"
                  >
                    Retry
                  </button>
                </div>
              ) : clients.length === 0 ? (
                <div className="flex flex-col items-center py-12 gap-2 text-center px-6">
                  <p className="text-slate-300 font-medium">No clients yet</p>
                  <p className="text-slate-500 text-sm">Add your first client using the form above.</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-800">
                  {clients.map((client) => (
                    editClientId === client.id && clientDraft ? (
                      /* Inline edit row */
                      <li key={client.id} className="px-6 py-4 bg-slate-800/30">
                        <form onSubmit={(e) => handleSaveClient(e, client.id)} className="flex flex-col gap-3">
                          <input
                            type="text"
                            value={clientDraft.name}
                            onChange={(e) => setClientDraft({ ...clientDraft, name: e.target.value })}
                            placeholder="Client name"
                            className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                       text-sm placeholder:text-slate-500
                                       focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                          />

                          <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs text-slate-400">Default rate / hr</label>
                              <input
                                type="number"
                                step="0.01"
                                value={clientDraft.default_rate}
                                onChange={(e) => setClientDraft({ ...clientDraft, default_rate: e.target.value })}
                                placeholder="Blank = none"
                                className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                           text-sm placeholder:text-slate-500
                                           focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                              />
                              {rateInputWarning(clientDraft.default_rate) && (
                                <p className="text-xs text-amber-400">
                                  {rateInputWarning(clientDraft.default_rate)}
                                </p>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs text-slate-400">Currency</label>
                              <input
                                type="text"
                                value={clientDraft.currency}
                                onChange={(e) => setClientDraft({ ...clientDraft, currency: e.target.value })}
                                placeholder="USD"
                                className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                           text-sm placeholder:text-slate-500
                                           focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                              />
                            </div>
                          </div>

                          <div className="flex flex-col gap-1">
                            <label className="text-xs text-slate-400">Billing email</label>
                            <input
                              type="email"
                              value={clientDraft.billing_email}
                              onChange={(e) => setClientDraft({ ...clientDraft, billing_email: e.target.value })}
                              placeholder="billing@acme.com"
                              className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                         text-sm placeholder:text-slate-500
                                         focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                            />
                          </div>

                          <div className="flex flex-col gap-1">
                            <label className="text-xs text-slate-400">Billing address</label>
                            <textarea
                              rows={3}
                              value={clientDraft.billing_address}
                              onChange={(e) => setClientDraft({ ...clientDraft, billing_address: e.target.value })}
                              placeholder={'123 Example Rd\nSingapore 123456'}
                              className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                         text-sm placeholder:text-slate-500 resize-y
                                         focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                            />
                          </div>

                          {editClientError && (
                            <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                              {editClientError}
                            </p>
                          )}

                          <div className="flex items-center gap-2">
                            <button
                              type="submit"
                              disabled={savingClientId === client.id}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                                         text-white bg-violet-600 rounded-lg hover:bg-violet-500 transition-colors
                                         disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {savingClientId === client.id && (
                                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              )}
                              {savingClientId === client.id ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditClient}
                              className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      </li>
                    ) : (
                    <li
                      key={client.id}
                      className="flex items-center justify-between px-6 py-3.5 hover:bg-slate-800/50 transition-colors"
                    >
                      <div>
                        <span className="text-sm text-slate-100 font-medium">{client.name}</span>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {client.default_rate !== null
                            ? `${formatMoney(client.default_rate, client.currency)}/hr`
                            : 'No default rate'}
                          {' · '}
                          {projects.filter((p) => p.client_id === client.id).length} project
                          {projects.filter((p) => p.client_id === client.id).length !== 1 ? 's' : ''}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        {confirmDeleteClientId === client.id ? (
                          <>
                            <span className="text-xs text-slate-400">Delete?</span>
                            <button
                              onClick={() => handleDeleteClient(client.id)}
                              disabled={deletingClientId === client.id}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 rounded-lg
                                         hover:bg-red-500 transition-colors disabled:opacity-50 flex items-center gap-1"
                            >
                              {deletingClientId === client.id && (
                                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              )}
                              Yes
                            </button>
                            <button
                              onClick={() => setConfirmDeleteClientId(null)}
                              className="px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                            >
                              No
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => startEditClient(client)}
                              className="p-1.5 text-slate-500 hover:text-violet-400 hover:bg-violet-400/10 rounded-lg transition-colors"
                              title="Edit client"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round"
                                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => setConfirmDeleteClientId(client.id)}
                              className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                              title="Delete client"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round"
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                    )
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── Projects column ── */}
          <div className="flex flex-col gap-6">
            {/* Add project form */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <h2 className="text-base font-semibold text-slate-100 mb-4">Add Project</h2>
              <form onSubmit={handleAddProject} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="project-client" className="text-sm font-medium text-slate-300">
                    Client
                  </label>
                  {clients.length === 0 ? (
                    <p className="text-sm text-slate-500 italic">
                      Add a client first before creating projects.
                    </p>
                  ) : (
                    <select
                      id="project-client"
                      value={newProjectClientId}
                      onChange={(e) => setNewProjectClientId(e.target.value)}
                      disabled={addingProject}
                      className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                                 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="">Select a client…</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="project-name" className="text-sm font-medium text-slate-300">
                    Project Name
                  </label>
                  <input
                    id="project-name"
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    disabled={addingProject || clients.length === 0}
                    placeholder="e.g. Website Redesign"
                    className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                               text-sm placeholder:text-slate-500
                               focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                               disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="project-rate" className="text-sm font-medium text-slate-300">
                    Rate
                  </label>
                  <input
                    id="project-rate"
                    type="number"
                    step="0.01"
                    value={newProjectRate}
                    onChange={(e) => setNewProjectRate(e.target.value)}
                    placeholder="e.g. 95"
                    className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                               text-sm placeholder:text-slate-500
                               focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  />
                  <p className="text-xs text-slate-500">
                    Per hour. Leave blank to inherit the client default.
                  </p>
                  {rateInputWarning(newProjectRate) && (
                    <p className="text-xs text-amber-400">{rateInputWarning(newProjectRate)}</p>
                  )}
                </div>

                {addProjectError && (
                  <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                    {addProjectError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={addingProject || clients.length === 0}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium
                             text-white bg-violet-600 rounded-lg hover:bg-violet-500 transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {addingProject && (
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  {addingProject ? 'Adding…' : 'Add Project'}
                </button>
              </form>
            </div>

            {/* Projects list */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-800">
                <h2 className="text-base font-semibold text-slate-100">
                  Projects
                  {!projectsLoading && (
                    <span className="ml-2 text-sm font-normal text-slate-500">
                      ({projects.length})
                    </span>
                  )}
                </h2>
              </div>

              {projectsLoading ? (
                <div className="flex items-center justify-center py-12 gap-3">
                  <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-slate-400 text-sm">Loading projects…</p>
                </div>
              ) : projectsError ? (
                <div className="flex flex-col items-center py-12 gap-3 text-center px-6">
                  <p className="text-red-400 text-sm">{projectsError}</p>
                  <button
                    onClick={fetchProjects}
                    className="text-sm text-violet-400 hover:text-violet-300 underline"
                  >
                    Retry
                  </button>
                </div>
              ) : projects.length === 0 ? (
                <div className="flex flex-col items-center py-12 gap-2 text-center px-6">
                  <p className="text-slate-300 font-medium">No projects yet</p>
                  <p className="text-slate-500 text-sm">
                    {clients.length === 0
                      ? 'Add a client first, then create projects under it.'
                      : 'Add your first project using the form above.'}
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-800">
                  {projects.map((project) => {
                    // Display only: the server snapshots the real rate at invoice
                    // build time. A null project rate inherits the client default.
                    const owner = clients.find((c) => c.id === project.client_id);
                    const currency = owner?.currency ?? 'USD';
                    const effectiveRate = project.rate ?? owner?.default_rate ?? null;
                    const inherited = project.rate === null && effectiveRate !== null;

                    return editProjectId === project.id && projectDraft ? (
                      /* Inline edit row */
                      <li key={project.id} className="px-6 py-4 bg-slate-800/30">
                        <form onSubmit={(e) => handleSaveProject(e, project.id)} className="flex flex-col gap-3">
                          <input
                            type="text"
                            value={projectDraft.name}
                            onChange={(e) => setProjectDraft({ ...projectDraft, name: e.target.value })}
                            placeholder="Project name"
                            className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                       text-sm placeholder:text-slate-500
                                       focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                          />

                          <div className="flex flex-col gap-1">
                            <label className="text-xs text-slate-400">Rate / hr</label>
                            <input
                              type="number"
                              step="0.01"
                              value={projectDraft.rate}
                              onChange={(e) => setProjectDraft({ ...projectDraft, rate: e.target.value })}
                              placeholder="Blank = inherit client default"
                              className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2
                                         text-sm placeholder:text-slate-500
                                         focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                            />
                            <p className="text-xs text-slate-500">
                              {owner?.default_rate != null
                                ? `Client default is ${formatMoney(owner.default_rate, currency)}/hr.`
                                : 'This client has no default rate.'}
                            </p>
                            {rateInputWarning(projectDraft.rate) && (
                              <p className="text-xs text-amber-400">
                                {rateInputWarning(projectDraft.rate)}
                              </p>
                            )}
                          </div>

                          {editProjectError && (
                            <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                              {editProjectError}
                            </p>
                          )}

                          <div className="flex items-center gap-2">
                            <button
                              type="submit"
                              disabled={savingProjectId === project.id}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                                         text-white bg-violet-600 rounded-lg hover:bg-violet-500 transition-colors
                                         disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {savingProjectId === project.id && (
                                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              )}
                              {savingProjectId === project.id ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditProject}
                              className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      </li>
                    ) : (
                    <li
                      key={project.id}
                      className="flex items-center justify-between px-6 py-3.5 hover:bg-slate-800/50 transition-colors"
                    >
                      <div>
                        <span className="text-sm text-slate-100 font-medium">{project.name}</span>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {project.client_name}
                        </p>
                        {effectiveRate === null ? (
                          <p className="text-xs text-slate-600 mt-0.5">No rate set</p>
                        ) : inherited ? (
                          <p className="text-xs text-slate-600 mt-0.5 italic">
                            {formatMoney(effectiveRate, currency)}/hr (from client)
                          </p>
                        ) : (
                          <p className="text-xs text-slate-400 mt-0.5">
                            {formatMoney(effectiveRate, currency)}/hr
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {confirmDeleteProjectId === project.id ? (
                          <>
                            <span className="text-xs text-slate-400">Delete?</span>
                            <button
                              onClick={() => handleDeleteProject(project.id)}
                              disabled={deletingProjectId === project.id}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 rounded-lg
                                         hover:bg-red-500 transition-colors disabled:opacity-50 flex items-center gap-1"
                            >
                              {deletingProjectId === project.id && (
                                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              )}
                              Yes
                            </button>
                            <button
                              onClick={() => setConfirmDeleteProjectId(null)}
                              className="px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                            >
                              No
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => startEditProject(project)}
                              className="p-1.5 text-slate-500 hover:text-violet-400 hover:bg-violet-400/10 rounded-lg transition-colors"
                              title="Edit project"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round"
                                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => setConfirmDeleteProjectId(project.id)}
                              className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                              title="Delete project"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round"
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
