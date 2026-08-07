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
  currency: string;              // e.g. "USD"
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

// Several tasks from one pasted list. JSON, not multipart — bulk-created tasks
// carry no attachments.
export interface BulkCreateTasksPayload {
  project_id: string;
  titles: string[];
  parent_task_id?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: string;
}

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
  // Invoices billing this tracker directly as a line. Maintained by the
  // invoice router, the same way a time entry records its claims.
  invoice_ids: string[];
  invoice_numbers: string[];
  datetime_inserted: string;
  datetime_updated: string;
}

// Start a tracker and a task for it in one go. The task is created first and
// attached to the tracker, so a work block you have not planned as a task yet
// still ends up with one — which is what makes its hours reachable from an
// invoice.
export interface NewTrackerTask {
  project_id: string;              // required — a task cannot exist without one
  title?: string;                  // defaults to the tracker's title
  status?: TaskStatus;             // defaults to "in_progress"
  priority?: TaskPriority;         // defaults to "medium"
}

// Settings for how a new tracker names itself. A second singleton alongside the
// invoice one, on its own document — tracker naming has nothing to do with
// issuing an invoice, and putting it in the invoice document would make the
// invoice settings form responsible for a field it never shows.
export interface TrackerSettings {
  // Whether the tracker form pre-fills its title at all. Off leaves the field
  // blank, exactly as before this existed.
  auto_name_enabled: boolean;
  // Text with {token} placeholders — see front/src/lib/trackerName.ts for the
  // list. "{date} tasks" renders as "2026-08-07 tasks".
  auto_name_template: string;
  datetime_inserted: string;
  datetime_updated: string;
}

// Timestamps are server-owned — never sent back on update.
export interface UpdateTrackerSettingsPayload
  extends Partial<Omit<TrackerSettings, 'datetime_inserted' | 'datetime_updated'>> {}

export interface CreateTrackerPayload {
  title: string;
  start_time: string;
  end_time?: string;
  notes?: string;
  task_ids?: string[];
  new_task?: NewTrackerTask;
}

export interface UpdateTrackerPayload {
  title?: string;
  start_time?: string;
  end_time?: string;  // pass "null" to clear
  notes?: string;     // pass "null" to clear
}

// Turning a tracker's elapsed time into billable time entries — the bridge from
// a tracker to an invoice. A tracker alone carries no billable time.
export interface BillTrackerPayload {
  split?: 'even' | 'full';   // share the hours out, or bill the span per task
  hours?: number;            // overrides the tracker's own span
  billable?: boolean;
  task_ids?: string[];       // defaults to every task on the tracker
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
  // Provenance for a line billed from a tracker rather than from time entries.
  // null on task lines and manual lines.
  tracker_id: string | null;
  // The task titles printed as a bullet list under the description. A snapshot
  // taken at build time, like task_title — editable per line, and never
  // re-read from the tasks afterwards, so a renamed task cannot rewrite a
  // past invoice.
  sub_items: string[];
}

export interface InvoiceIssuedBy {
  business_name: string;
  contact_name: string;   // the person issuing it; "" on invoices predating it
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
  // Print-only switches. They hide a block on the printed document; the stored
  // value is untouched and stays editable.
  show_due_date: boolean;
  show_payment_terms: boolean;
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
  // Trackers whose span falls in the period are offered as their own lines,
  // billed from elapsed time. Defaults to true server-side.
  include_trackers?: boolean;
  // Set when re-previewing for an invoice that already exists, so its own
  // claims are ignored. Without it an invoice's entries read as already
  // billed — by that very invoice — and regenerating would drop every line
  // it currently holds.
  for_invoice_id?: string;
}

// Mirrors InvoicePreviewResponse in back/routers/invoices.py — the preview does
// not carry bill_to; that is snapshotted onto the invoice only at creation.
export interface InvoicePreviewResponse {
  client_id: string;
  client_name: string;
  currency: string;
  period_start: string;
  period_end: string;
  lines: InvoicePreviewLine[];
  subtotal: number;
  running_entry_count: number;  // entries with no end_time and no manual hours
  claimed_entry_count: number;  // entries already billed on another invoice
  tracker_line_count: number;   // how many of the lines came from a tracker
  // Tracker lines arriving unticked because including them would bill hours
  // that are already on the invoice as task lines.
  duplicate_tracker_count: number;
}

// Where a previewed line came from. A stored invoice does not record this —
// it only matters while deciding what to bill.
export type InvoiceLineSource = 'time_entry' | 'tracker';

// Build-time facts about a previewed line. Deliberately not on InvoiceLine —
// a stored invoice never carries them. Always present; 0 / [] when clean.
export interface InvoicePreviewLine extends InvoiceLine {
  claimed_entry_count: number;
  claimed_by: string[];         // invoice numbers already claiming these entries
  source: InvoiceLineSource;
  // false when ticking this line would double-bill, or when a tracker is still
  // running so there are no hours to derive. The line is still offered and
  // still tickable — warn, never block (§ no locking).
  include_by_default: boolean;
  // Plain-language reason behind include_by_default === false; null when clean.
  duplicate_reason: string | null;
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
  show_due_date?: boolean;
  show_payment_terms?: boolean;
}

export interface UpdateInvoicePayload extends Partial<CreateInvoicePayload> {}

// How billable hours are rounded onto an increment. "nearest" is the usual
// convention; "up" is the aggressive one and never lowers a figure.
export type HoursRoundingDirection = 'nearest' | 'up' | 'down';

export interface InvoiceSettings {
  business_name: string;
  contact_name: string;
  address: string;
  email: string;
  logo_url: string | null;
  default_currency: string;
  default_payment_terms: string;
  default_due_days: number;
  default_tax_label: string;
  default_tax_percent: number;
  default_rate: number;
  // The billing increment hours snap to, in hours — 0.25 is a quarter hour.
  // 0 turns rounding off. Never applied on its own: it is the default the
  // "Round hours" action offers, and the user still chooses which lines it
  // touches, so no figure is ever rewritten without being asked for.
  hours_rounding_increment: number;
  hours_rounding_direction: HoursRoundingDirection;
  invoice_prefix: string;
  reset_sequence_yearly: boolean;
  datetime_inserted: string;
  datetime_updated: string;
}

// Timestamps are server-owned — never sent back on update.
export interface UpdateInvoiceSettingsPayload
  extends Partial<Omit<InvoiceSettings, 'datetime_inserted' | 'datetime_updated'>> {}
