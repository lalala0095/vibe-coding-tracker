export interface Model {
  id: string;
  name: string;
}

export interface Attachment {
  name: string;
  gcs_url: string;
}

export interface Goal {
  id: string;
  datetime_inserted: string; // ISO datetime in Singapore TZ
  model_id: string;
  model_name: string;
  goal: string;
  attachments: Attachment[];
  output: string;
  task_id?: string;
  task_title?: string;
}

export interface CreateGoalPayload {
  model_id: string;
  goal: string;
  output: string;
  task_id?: string;
}

export interface UpdateGoalPayload {
  model_id: string;
  goal: string;
  output: string;
  task_id?: string;
}

export interface Client {
  id: string;
  name: string;
  datetime_inserted: string;
}

export interface Project {
  id: string;
  name: string;
  client_id: string;
  client_name: string;
  datetime_inserted: string;
}

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  title: string;
  description: string;
  project_id: string;
  project_name: string;
  client_id: string;
  client_name: string;
  parent_task_id: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;    // "YYYY-MM-DD"
  attachments: Attachment[];
  datetime_inserted: string;
  datetime_updated: string;
}

export interface CreateTaskPayload {
  title: string;
  description?: string;
  project_id: string;
  parent_task_id?: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date?: string;
}

export interface UpdateTaskPayload extends Partial<CreateTaskPayload> {}

// ── Trackers ──────────────────────────────────────────────────────────────────

export interface TrackerTaskRef {
  task_id: string;
  task_title: string;
  project_name: string;
  client_name: string;
}

export interface Tracker {
  id: string;
  title: string;
  start_time: string;    // ISO-8601 datetime
  end_time: string | null;
  notes: string | null;
  tasks: TrackerTaskRef[];
  datetime_inserted: string;
  datetime_updated: string;
}

export interface CreateTrackerPayload {
  title: string;
  start_time: string;
  end_time?: string;
  notes?: string;
  task_ids?: string[];
}

export interface UpdateTrackerPayload {
  title?: string;
  start_time?: string;
  end_time?: string;  // pass "null" to clear
  notes?: string;     // pass "null" to clear
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  task_id: string;
  task_title: string;
  project_id: string;
  project_name: string;
  client_id: string;
  client_name: string;
  tracker_id: string | null;
  start_time: string;    // ISO-8601 datetime
  end_time: string | null;
  duration_minutes: number | null;
  notes: string | null;
  datetime_inserted: string;
  datetime_updated: string;
}

export interface CreateSessionPayload {
  task_id: string;
  start_time: string;
  end_time?: string;
  notes?: string;
  tracker_id?: string;
}

export interface UpdateSessionPayload {
  task_id?: string;
  start_time?: string;
  end_time?: string;    // pass "null" to clear
  notes?: string;       // pass "null" to clear
  tracker_id?: string;  // pass "null" to clear
}
