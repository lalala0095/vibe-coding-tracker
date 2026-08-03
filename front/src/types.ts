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
  default_rate: number | null;
  currency: string;              // e.g. "SGD"
  billing_email: string | null;
  billing_address: string | null;
  datetime_inserted: string;
}

export interface Project {
  id: string;
  name: string;
  client_id: string;
  client_name: string;
  rate: number | null;    // overrides the client default
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

// ── Time Entries ──────────────────────────────────────────────────────────────
// The `sessions` collection holds time entries. The wire types keep the API
// name (`Session`); new UI code uses the `TimeEntry` aliases below. The UI label
// "Sessions" belongs to `goals` — never to these.

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
  hours: number | null;          // manual override; null = fall back to computed
  billable: boolean;
  // An entry can be claimed by more than one invoice. The lists are the truth;
  // the scalars are derived from the most recent claim, for display only.
  invoice_ids: string[];
  invoice_numbers: string[];
  invoice_id: string | null;
  invoice_number: string | null;
  effective_hours: number;       // hours ?? duration_minutes/60 ?? 0
  notes: string | null;
  datetime_inserted: string;
  datetime_updated: string;
}

export interface CreateSessionPayload {
  task_id: string;
  start_time: string;
  end_time?: string;
  hours?: number;
  billable?: boolean;
  notes?: string;
  tracker_id?: string;
}

export interface UpdateSessionPayload {
  task_id?: string;
  start_time?: string;
  end_time?: string;    // pass "null" to clear
  hours?: number | null;
  billable?: boolean;
  notes?: string;       // pass "null" to clear
  tracker_id?: string;  // pass "null" to clear
}

export type TimeEntry = Session;
export type CreateTimeEntryPayload = CreateSessionPayload;
export type UpdateTimeEntryPayload = UpdateSessionPayload;

// ── Invoices ──────────────────────────────────────────────────────────────────

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'void';

export interface InvoiceLine {
  line_id: string;
  task_id: string | null;      // null for a manually added line
  task_title: string;
  project_id: string | null;
  project_name: string;
  description: string;         // defaults to task_title
  date_from: string | null;    // "YYYY-MM-DD"
  date_to: string | null;      // "YYYY-MM-DD"
  hours: number;
  rate: number;
  amount: number;              // server-computed
  session_ids: string[];       // provenance; empty for manual lines
}

export interface InvoiceIssuedBy {
  business_name: string;
  address: string;
  email: string;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  project_ids: string[];
  project_names: string[];
  status: InvoiceStatus;
  issue_date: string;          // "YYYY-MM-DD"
  due_date: string | null;
  period_start: string | null;
  period_end: string | null;
  currency: string;
  lines: InvoiceLine[];
  subtotal: number;
  discount_type: 'percent' | 'amount' | null;
  discount_value: number;
  discount_amount: number;
  tax_label: string | null;
  tax_percent: number;
  tax_amount: number;
  total: number;
  notes: string | null;
  payment_terms: string | null;
  bill_to: string;             // snapshot at creation
  issued_by: InvoiceIssuedBy;  // snapshot at creation
  datetime_inserted: string;
  datetime_updated: string;
}

export interface InvoicePreviewRequest {
  client_id: string;
  project_ids?: string[];
  period_start: string;
  period_end: string;
  include_invoiced?: boolean;
}

// Mirrors InvoicePreviewResponse in back/routers/invoices.py — the preview does
// not carry bill_to; that is snapshotted onto the invoice only at creation.
export interface InvoicePreviewResponse {
  client_id: string;
  client_name: string;
  currency: string;
  period_start: string;
  period_end: string;
  lines: InvoiceLine[];
  subtotal: number;
  running_entry_count: number;  // entries with no end_time and no manual hours
}

export interface CreateInvoicePayload {
  client_id: string;
  project_ids?: string[];
  status?: InvoiceStatus;
  issue_date: string;
  due_date?: string | null;
  period_start: string;
  period_end: string;
  currency?: string;
  lines: InvoiceLine[];
  discount_type?: 'percent' | 'amount' | null;
  discount_value?: number;
  tax_label?: string;
  tax_percent?: number;
  notes?: string;
  payment_terms?: string;
}

export interface UpdateInvoicePayload extends Partial<CreateInvoicePayload> {}

export interface InvoiceSettings {
  business_name: string;
  address: string;
  email: string;
  logo_url: string | null;
  default_currency: string;
  default_payment_terms: string;
  default_due_days: number;
  default_tax_label: string;
  default_tax_percent: number;
  default_rate: number;
  invoice_prefix: string;
  reset_sequence_yearly: boolean;
  datetime_inserted: string;
  datetime_updated: string;
}

// Timestamps are server-owned — never sent back on update.
export interface UpdateInvoiceSettingsPayload
  extends Partial<Omit<InvoiceSettings, 'datetime_inserted' | 'datetime_updated'>> {}
