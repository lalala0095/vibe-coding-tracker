// Every HTTP call the phone makes. Components never call axios directly — the
// same rule `front/src/api.ts` follows.
//
// Unlike `types.ts`, which is copied whole, this file carries **only** the
// endpoints v1 actually uses. Invoices, payments, goals, models, clients CRUD
// and both settings writers stay on the web, so they are absent here rather
// than present and unexercised.

import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';

import type {
  BulkCreateTasksPayload,
  Client,
  CreateSessionPayload,
  CreateTaskPayload,
  CreateTrackerPayload,
  BillTrackerPayload,
  Project,
  Session,
  Task,
  Tracker,
  TrackerSettings,
  UpdateSessionPayload,
  UpdateTaskPayload,
  UpdateTrackerPayload,
} from './types';

// `EXPO_PUBLIC_*` is inlined into the bundle at build time. Both values this app
// reads are already public in the web bundle, so nothing is being exposed that
// was not exposed before. Nothing from `back/.env.deploy` is read here, ever.
const baseURL = process.env.EXPO_PUBLIC_API_URL;

if (!baseURL) {
  // Fail loudly at import rather than turning every screen into a mystery
  // network error.
  console.error(
    'EXPO_PUBLIC_API_URL is not set. The app cannot reach the API. ' +
      'Set it in .env (local) or as an EAS build env var.'
  );
}

const apiClient = axios.create({
  baseURL,
  // Cloud Run cold starts are real; the default of "no timeout" would leave a
  // spinner up forever on a dead connection instead.
  timeout: 30_000,
});

// ── Session token ─────────────────────────────────────────────────────────────
//
// Held in memory and set by `src/auth.tsx`, which owns persistence in
// `expo-secure-store`. Keeping it in a module variable means the request
// interceptor stays synchronous — SecureStore is async, and awaiting it on
// every single request would add a disk read to each call for no benefit.

let sessionToken: string | null = null;

export function setAuthToken(token: string | null): void {
  sessionToken = token;
}

apiClient.interceptors.request.use((config) => {
  if (sessionToken) {
    config.headers.Authorization = `Bearer ${sessionToken}`;
  }
  return config;
});

// ── Expired sessions ──────────────────────────────────────────────────────────
//
// `back/auth.py` answers **401 when the token is missing** and **403 when it is
// expired or invalid** — both mean "this session is over", and both must be
// handled or the app sits on a screen full of failed requests.
//
// The handler is registered by `auth.tsx` rather than imported, so `api.ts`
// stays free of any dependency on React or on the auth module. The JWT lasts 7
// days and there is no refresh endpoint (`back/routers/auth_router.py`), so
// recovery is a silent Google re-sign-in, and failing that, the sign-in screen.

/**
 * Attempt to recover a lapsed session. Resolves `true` when a fresh token is in
 * place, `false` when the user has to sign in again.
 *
 * Registered by `auth.tsx`, which is also responsible for making concurrent
 * calls share **one** recovery: a screen that fires three requests in parallel
 * gets three 401s, and three simultaneous Google re-sign-ins would be both
 * wasteful and racy.
 */
type AuthFailureHandler = () => Promise<boolean>;

let onAuthFailure: AuthFailureHandler | null = null;

export function setAuthFailureHandler(handler: AuthFailureHandler | null): void {
  onAuthFailure = handler;
}

/** Marks a request that has already been through one recovery attempt. */
type RetriableConfig = InternalAxiosRequestConfig & { _authRetried?: boolean };

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const status = error.response?.status;
    const config = error.config as RetriableConfig | undefined;

    // `/auth/login` failing means Google rejected the ID token, not that an
    // existing session lapsed. Recovering from it would call the very endpoint
    // that just failed.
    const isLogin = config?.url?.includes('/auth/login');
    const isSessionOver = status === 401 || status === 403;

    if (isSessionOver && !isLogin) {
      sessionToken = null;

      // Replay the original request once if the session comes back. Without
      // this the user is left tapping "Try again" on a session that is already
      // healthy — and with a 7-day token and no refresh endpoint, that lands
      // roughly weekly. `_authRetried` is set *before* the retry, so a second
      // failure rejects instead of looping.
      if (config && !config._authRetried && onAuthFailure) {
        config._authRetried = true;
        const recovered = await onAuthFailure();
        if (recovered && sessionToken) {
          return apiClient.request(config);
        }
      }
    }
    return Promise.reject(error);
  }
);

/**
 * A message worth showing a user.
 *
 * FastAPI puts its message in `detail`; everything else here is the difference
 * between "no signal" and "the server said no", which matters when the only
 * feedback is a line of red text on a phone.
 */
export function apiErrorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : fallback;
  }

  const detail = (error.response?.data as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;

  if (error.code === 'ECONNABORTED') return 'The server took too long to answer. Try again.';
  if (!error.response) return 'No connection. Check your signal and try again.';

  return error.response.status >= 500
    ? 'The server hit an error. Try again in a moment.'
    : fallback;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

export async function exchangeGoogleToken(
  googleIdToken: string
): Promise<{ session_token: string; user: SessionUser }> {
  const res = await apiClient.post('/auth/login', { id_token: googleIdToken });
  return res.data;
}

// ── Clients & Projects ────────────────────────────────────────────────────────
// Read-only here. Both exist so a task can be filed against a project and a
// time entry filtered by client; neither is editable on the phone.

export async function getClients(): Promise<Client[]> {
  const res = await apiClient.get<Client[]>('/clients');
  return res.data;
}

export async function getProjects(clientId?: string): Promise<Project[]> {
  const res = await apiClient.get<Project[]>('/projects', {
    params: clientId ? { client_id: clientId } : undefined,
  });
  return res.data;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
//
// `POST /tasks` and `PUT /tasks/{id}` are `multipart/form-data` on the server
// because attachments share the endpoint (`back/routers/tasks.py` declares every
// field as `Form(...)`). v1 uploads no files, but the contract is the contract,
// so these still post a FormData — just one with no file parts.
//
// The `Content-Type` header is deliberately NOT set. On React Native the
// platform generates the multipart boundary when it sees a FormData body;
// setting the header by hand overwrites it with a boundary-less value and the
// server then fails to parse a body that looks perfectly fine on the wire.

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

export async function createTask(payload: CreateTaskPayload): Promise<Task> {
  const form = new FormData();
  form.append('title', payload.title);
  if (payload.description) form.append('description', payload.description);
  form.append('project_id', payload.project_id);
  if (payload.parent_task_id) form.append('parent_task_id', payload.parent_task_id);
  form.append('status', payload.status);
  form.append('priority', payload.priority);
  if (payload.due_date) form.append('due_date', payload.due_date);

  const res = await apiClient.post<Task>('/tasks', form);
  return res.data;
}

/** Many tasks from one pasted list — JSON, one round trip, no attachments. */
export async function createTasksBulk(payload: BulkCreateTasksPayload): Promise<Task[]> {
  const res = await apiClient.post<Task[]>('/tasks/bulk', payload);
  return res.data;
}

export async function updateTask(id: string, payload: UpdateTaskPayload): Promise<Task> {
  const form = new FormData();
  // `undefined` means "leave alone"; the literal string "null" clears an
  // optional field, per the convention in MyTrackerFormat.md.
  if (payload.title !== undefined) form.append('title', payload.title);
  if (payload.description !== undefined) form.append('description', payload.description);
  if (payload.project_id !== undefined) form.append('project_id', payload.project_id);
  if (payload.parent_task_id !== undefined) form.append('parent_task_id', payload.parent_task_id);
  if (payload.status !== undefined) form.append('status', payload.status);
  if (payload.priority !== undefined) form.append('priority', payload.priority);
  if (payload.due_date !== undefined) form.append('due_date', payload.due_date);

  const res = await apiClient.put<Task>(`/tasks/${id}`, form);
  return res.data;
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

/**
 * Turn a tracker's elapsed time into time entries.
 *
 * The only route by which a tracker's hours reach an invoice. Returns the
 * entries created; an empty array means every task on the tracker had already
 * been billed from it.
 */
export async function billTracker(
  id: string,
  payload: BillTrackerPayload = {}
): Promise<Session[]> {
  const res = await apiClient.post<Session[]>(`/trackers/${id}/time-entries`, payload);
  return res.data;
}

// ── Time Entries ──────────────────────────────────────────────────────────────
// The `sessions` collection. Never labelled "Sessions" in the UI — that word
// belongs to `goals`, which this app does not ship.

export async function getSessions(params?: {
  task_id?: string;
  tracker_id?: string;
  client_id?: string;
  project_id?: string;
  date_from?: string;   // "YYYY-MM-DD"
  date_to?: string;     // "YYYY-MM-DD"
  billable?: boolean;
  uninvoiced_only?: boolean;
}): Promise<Session[]> {
  const res = await apiClient.get<Session[]>('/sessions', { params });
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

// ── Settings ──────────────────────────────────────────────────────────────────
// Read-only: the phone renders a new tracker's name from the stored template,
// but editing that template stays on the web.

export async function getTrackerSettings(): Promise<TrackerSettings> {
  const res = await apiClient.get<TrackerSettings>('/settings/tracker');
  return res.data;
}
