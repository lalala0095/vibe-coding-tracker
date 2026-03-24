import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { getClients, createClient, deleteClient, getProjects, createProject, deleteProject } from '../api';
import type { Client, Project } from '../types';

export default function ClientsProjectsPage() {
  const { user, logout } = useAuth();

  // Clients state
  const [clients, setClients] = useState<Client[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsError, setClientsError] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [addingClient, setAddingClient] = useState(false);
  const [addClientError, setAddClientError] = useState('');
  const [confirmDeleteClientId, setConfirmDeleteClientId] = useState<string | null>(null);
  const [deletingClientId, setDeletingClientId] = useState<string | null>(null);

  // Projects state
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectClientId, setNewProjectClientId] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState('');
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);

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
    setAddingClient(true);
    try {
      const created = await createClient(name);
      setClients((prev) => [...prev, created]);
      setNewClientName('');
      // Auto-select new client for project form
      setNewProjectClientId(created.id);
    } catch {
      setAddClientError('Failed to create client. Please try again.');
    } finally {
      setAddingClient(false);
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
    setAddingProject(true);
    try {
      const created = await createProject(name, newProjectClientId);
      setProjects((prev) => [...prev, created]);
      setNewProjectName('');
    } catch {
      setAddProjectError('Failed to create project. Please try again.');
    } finally {
      setAddingProject(false);
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
      {/* ── Navigation Header ── */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-sm border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          {/* Left: brand */}
          <div className="flex items-center gap-3">
            <Link
              to="/dashboard"
              className="flex items-center gap-3 hover:opacity-80 transition-opacity"
            >
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
              <span className="text-base font-semibold text-slate-100 hidden sm:block">
                Vibe Coding Tracker
              </span>
            </Link>
          </div>

          {/* Right: nav links + user */}
          <nav className="flex items-center gap-1">
            <Link
              to="/dashboard"
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Sessions
            </Link>
            <Link
              to="/tasks"
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Tasks
            </Link>
            <Link
              to="/models"
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Models
            </Link>
            <Link
              to="/manage"
              className="px-3 py-1.5 text-sm text-slate-100 bg-slate-800 rounded-lg transition-colors font-medium"
            >
              Clients &amp; Projects
            </Link>

            {user?.picture ? (
              <img
                src={user.picture}
                alt={user.name ?? 'User'}
                className="w-8 h-8 rounded-full border border-slate-700 ml-1"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs text-slate-300 ml-1">
                {user?.name?.[0] ?? user?.email?.[0] ?? '?'}
              </div>
            )}

            <button
              onClick={logout}
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

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
                    <li
                      key={client.id}
                      className="flex items-center justify-between px-6 py-3.5 hover:bg-slate-800/50 transition-colors"
                    >
                      <div>
                        <span className="text-sm text-slate-100 font-medium">{client.name}</span>
                        <p className="text-xs text-slate-500 mt-0.5">
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
                        )}
                      </div>
                    </li>
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
                  {projects.map((project) => (
                    <li
                      key={project.id}
                      className="flex items-center justify-between px-6 py-3.5 hover:bg-slate-800/50 transition-colors"
                    >
                      <div>
                        <span className="text-sm text-slate-100 font-medium">{project.name}</span>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {project.client_name}
                        </p>
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
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
