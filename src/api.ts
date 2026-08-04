import axios from 'axios';
import type {
  Goal, Model, CreateGoalPayload, UpdateGoalPayload,
  Client, Project, Task, CreateTaskPayload, UpdateTaskPayload,
  BulkCreateTasksPayload,
  Tracker, CreateTrackerPayload, UpdateTrackerPayload, BillTrackerPayload,
  Session, CreateSessionPayload, UpdateSessionPayload,
  Invoice, InvoiceStatus, InvoicePreviewRequest, InvoicePreviewResponse,
  CreateInvoicePayload, UpdateInvoicePayload,
  InvoiceSettings, UpdateInvoiceSettingsPayload,
} from './types';

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
});

// Attach session token to every request.
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('session_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Auth ─────────────────────────────────────────────────────────────────────

export async function exchangeGoogleToken(
  googleIdToken: string
): Promise<{ session_token: string; user: { sub: string; email: string; name: string; picture: string } }> {
  const res = await apiClient.post('/auth/login', { id_token: googleIdToken });
  return res.data;
}

// ── Models ──────────────────────────────────────────────────────────────────

export async function getModels(): Promise<Model[]> {
  const res = await apiClient.get<Model[]>('/models');
  return res.data;
}

export async function createModel(name: string): Promise<Model> {
  const res = await apiClient.post<Model>('/models', { name });
  return res.data;
}

export async function deleteModel(id: string): Promise<void> {
  await apiClient.delete(`/models/${id}`);
}

// ── Goals ───────────────────────────────────────────────────────────────────

export async function getGoals(params?: { task_id?: string }): Promise<Goal[]> {
  const res = await apiClient.get<Goal[]>('/goals', { params });
  return res.data;
}

export async function getGoal(id: string): Promise<Goal> {
  const res = await apiClient.get<Goal>(`/goals/${id}`);
  return res.data;
}

export async function createGoal(
  payload: CreateGoalPayload,
  files: File[]
): Promise<Goal> {
  const form = new FormData();
  form.append('model_id', payload.model_id);
  form.append('goal', payload.goal);
  form.append('output', payload.output);
  if (payload.task_id) form.append('task_id', payload.task_id);
  for (const file of files) {
    form.append('attachments', file);
  }
  const res = await apiClient.post<Goal>('/goals', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function updateGoal(
  id: string,
  payload: UpdateGoalPayload,
  _files: File[]
): Promise<Goal> {
  const res = await apiClient.put<Goal>(`/goals/${id}`, payload);
  return res.data;
}

export async function deleteGoal(id: string): Promise<void> {
  await apiClient.delete(`/goals/${id}`);
}

// ── Clients ──────────────────────────────────────────────────────────────────

export async function getClients(): Promise<Client[]> {
  const res = await apiClient.get<Client[]>('/clients');
  return res.data;
}

export interface ClientOptions {
  default_rate?: number | null;  // pass null to clear
  currency?: string;             // server defaults to "USD"
  billing_email?: string;        // pass "null" to clear
  billing_address?: string;      // pass "null" to clear
}

export async function createClient(name: string, options?: ClientOptions): Promise<Client> {
  const res = await apiClient.post<Client>('/clients', { name, ...options });
  return res.data;
}

export async function updateClient(
  id: string,
  payload: { name?: string } & ClientOptions
): Promise<Client> {
  const res = await apiClient.put<Client>(`/clients/${id}`, payload);
  return res.data;
}

export async function deleteClient(id: string): Promise<void> {
  await apiClient.delete(`/clients/${id}`);
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function getProjects(clientId?: string): Promise<Project[]> {
  const params = clientId ? { client_id: clientId } : undefined;
  const res = await apiClient.get<Project[]>('/projects', { params });
  return res.data;
}

export interface ProjectOptions {
  rate?: number | null;  // pass null to clear
}

export async function createProject(
  name: string,
  clientId: string,
  options?: ProjectOptions
): Promise<Project> {
  const res = await apiClient.post<Project>('/projects', { name, client_id: clientId, ...options });
  return res.data;
}

export async function updateProject(
  id: string,
  payload: { name?: string; client_id?: string } & ProjectOptions
): Promise<Project> {
  const res = await apiClient.put<Project>(`/projects/${id}`, payload);
  return res.data;
}

export async function deleteProject(id: string): Promise<void> {
  await apiClient.delete(`/projects/${id}`);
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export async function getTasks(params?: {
  project_id?: string;
  parent_task_id?: string;
  status?: string;
  priority?: string;
}): Promise<Task[]> {
  const res = await apiClient.get<Task[]>('/tasks', { params });
  return res.data;
}

export async function getTask(id: string): Promise<Task> {
  const res = await apiClient.get<Task>(`/tasks/${id}`);
  return res.data;
}

export async function createTask(payload: CreateTaskPayload, files: File[]): Promise<Task> {
  const form = new FormData();
  form.append('title', payload.title);
  if (payload.description) form.append('description', payload.description);
  form.append('project_id', payload.project_id);
  if (payload.parent_task_id) form.append('parent_task_id', payload.parent_task_id);
  form.append('status', payload.status);
  form.append('priority', payload.priority);
  if (payload.due_date) form.append('due_date', payload.due_date);
  for (const file of files) {
    form.append('attachments', file);
  }
  const res = await apiClient.post<Task>('/tasks', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

// Create many tasks from one pasted list. JSON rather than multipart — these
// carry no attachments — and one round trip rather than one call per title.
export async function createTasksBulk(payload: BulkCreateTasksPayload): Promise<Task[]> {
  const res = await apiClient.post<Task[]>('/tasks/bulk', payload);
  return res.data;
}

export async function updateTask(
  id: string,
  payload: UpdateTaskPayload,
  files: File[]
): Promise<Task> {
  const form = new FormData();
  if (payload.title !== undefined) form.append('title', payload.title);
  if (payload.description !== undefined) form.append('description', payload.description);
  if (payload.project_id !== undefined) form.append('project_id', payload.project_id);
  if (payload.parent_task_id !== undefined) form.append('parent_task_id', payload.parent_task_id);
  if (payload.status !== undefined) form.append('status', payload.status);
  if (payload.priority !== undefined) form.append('priority', payload.priority);
  if (payload.due_date !== undefined) form.append('due_date', payload.due_date);
  for (const file of files) {
    form.append('attachments', file);
  }
  const res = await apiClient.put<Task>(`/tasks/${id}`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function deleteTask(id: string): Promise<void> {
  await apiClient.delete(`/tasks/${id}`);
}

// ── Trackers ──────────────────────────────────────────────────────────────────

export async function getTrackers(params?: { active_only?: boolean }): Promise<Tracker[]> {
  const res = await apiClient.get<Tracker[]>('/trackers', { params });
  return res.data;
}

export async function getTracker(id: string): Promise<Tracker> {
  const res = await apiClient.get<Tracker>(`/trackers/${id}`);
  return res.data;
}

export async function createTracker(payload: CreateTrackerPayload): Promise<Tracker> {
  const res = await apiClient.post<Tracker>('/trackers', payload);
  return res.data;
}

export async function updateTracker(id: string, payload: UpdateTrackerPayload): Promise<Tracker> {
  const res = await apiClient.put<Tracker>(`/trackers/${id}`, payload);
  return res.data;
}

export async function addTasksToTracker(id: string, taskIds: string[]): Promise<Tracker> {
  const res = await apiClient.post<Tracker>(`/trackers/${id}/tasks`, { task_ids: taskIds });
  return res.data;
}

export async function removeTaskFromTracker(trackerId: string, taskId: string): Promise<Tracker> {
  const res = await apiClient.delete<Tracker>(`/trackers/${trackerId}/tasks/${taskId}`);
  return res.data;
}

// Turn a tracker's elapsed time into time entries — the only route by which a
// tracker's hours reach an invoice. Returns the entries created; an empty array
// means every task was already billed from this tracker.
export async function billTracker(id: string, payload: BillTrackerPayload = {}): Promise<Session[]> {
  const res = await apiClient.post<Session[]>(`/trackers/${id}/time-entries`, payload);
  return res.data;
}

export async function deleteTracker(id: string): Promise<void> {
  await apiClient.delete(`/trackers/${id}`);
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function getSessions(params?: {
  task_id?: string;
  tracker_id?: string;
  client_id?: string;
  project_id?: string;
  date_from?: string;        // "YYYY-MM-DD"
  date_to?: string;          // "YYYY-MM-DD"
  billable?: boolean;
  uninvoiced_only?: boolean;
}): Promise<Session[]> {
  const res = await apiClient.get<Session[]>('/sessions', { params });
  return res.data;
}

export async function getSession(id: string): Promise<Session> {
  const res = await apiClient.get<Session>(`/sessions/${id}`);
  return res.data;
}

export async function createSession(payload: CreateSessionPayload): Promise<Session> {
  const res = await apiClient.post<Session>('/sessions', payload);
  return res.data;
}

export async function updateSession(id: string, payload: UpdateSessionPayload): Promise<Session> {
  const res = await apiClient.put<Session>(`/sessions/${id}`, payload);
  return res.data;
}

export async function deleteSession(id: string): Promise<void> {
  await apiClient.delete(`/sessions/${id}`);
}

// ── Invoices ──────────────────────────────────────────────────────────────────

export async function getInvoices(params?: {
  client_id?: string;
  status?: string;
}): Promise<Invoice[]> {
  const res = await apiClient.get<Invoice[]>('/invoices', { params });
  return res.data;
}

export async function getInvoice(id: string): Promise<Invoice> {
  const res = await apiClient.get<Invoice>(`/invoices/${id}`);
  return res.data;
}

// Builds draft lines from time entries without persisting anything.
export async function previewInvoice(payload: InvoicePreviewRequest): Promise<InvoicePreviewResponse> {
  const res = await apiClient.post<InvoicePreviewResponse>('/invoices/preview', payload);
  return res.data;
}

export async function createInvoice(payload: CreateInvoicePayload): Promise<Invoice> {
  const res = await apiClient.post<Invoice>('/invoices', payload);
  return res.data;
}

export async function updateInvoice(id: string, payload: UpdateInvoicePayload): Promise<Invoice> {
  const res = await apiClient.put<Invoice>(`/invoices/${id}`, payload);
  return res.data;
}

export async function updateInvoiceStatus(id: string, status: InvoiceStatus): Promise<Invoice> {
  const res = await apiClient.patch<Invoice>(`/invoices/${id}/status`, { status });
  return res.data;
}

export async function deleteInvoice(id: string): Promise<void> {
  await apiClient.delete(`/invoices/${id}`);
}

// ── Invoice settings ──────────────────────────────────────────────────────────

export async function getInvoiceSettings(): Promise<InvoiceSettings> {
  const res = await apiClient.get<InvoiceSettings>('/settings/invoice');
  return res.data;
}

export async function updateInvoiceSettings(
  payload: UpdateInvoiceSettingsPayload
): Promise<InvoiceSettings> {
  const res = await apiClient.put<InvoiceSettings>('/settings/invoice', payload);
  return res.data;
}
