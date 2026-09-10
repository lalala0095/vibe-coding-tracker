### Architecture
Backend: FastAPI (Python 3.11), deployed to Cloud Run
Frontend: React 18 + TypeScript + Vite + Tailwind CSS, deployed to Vercel
Database: GCP Firestore (native mode) + Google Cloud Storage for attachments
Auth: Google Sign-In → backend exchanges the Google ID token for a session JWT

### Hierarchy

```
Client → Project → Task (self-nesting via parent_task_id)
                     ├── goals    (AI prompt/output records)
                     └── sessions (time entries: start/end/hours)
Tracker → groups tasks into a work block; sessions may point at one
Invoice → built from a client + date range; one line per (task, project),
          with back-links written onto the sessions it billed
```

### Naming: "Session" means two different things

Read this before touching either collection.

| Collection | Contains | UI label |
|---|---|---|
| `goals` | AI prompt + output + model + attachments | **"Sessions"** |
| `sessions` | `task_id`, `start_time`, `end_time`, `hours` | **"Time Entries"** — never "Sessions" |

The backend collection and route stay `sessions` / `/sessions`. Only the UI label differs.
In frontend code the wire type is `Session` and `TimeEntry` is exported as an alias for UI use.

### Data Schema

All timestamps are ISO-8601 strings in Singapore time (UTC+8), written by `_now_sgt()`.
Document IDs are Firestore auto-IDs and are returned as `id`; they are not stored inside the document.

models: {
    "name": "name of the AI model used"
}

goals: {
    "datetime_inserted": "current datetime in Singapore Timezone",
    "model_id": "the id of the model from models collection",
    "model_name": "name field from models, for easy retrieval",
    "goal": "the description or the prompt to the AI",
    "attachments": [
        {
            "name": "file_name",
            "gcs_url": "public url pointing to the gcs"
        }
    ],
    "output": "the AI response",
    "task_id": "optional id of the task this goal belongs to | null",
    "task_title": "title field from tasks, denormalised | null"
}

clients: {
    "name": "client name",
    "default_rate": "fallback hourly rate used by invoicing | null",
    "currency": "currency label, defaults to SGD",
    "billing_email": "email used for billing | null",
    "billing_address": "multi-line address for the invoice Bill-To | null",
    "datetime_inserted": "..."
}

projects: {
    "name": "project name",
    "client_id": "the id of the client from clients collection",
    "client_name": "name field from clients, denormalised",
    "rate": "hourly rate that overrides the client default | null",
    "datetime_inserted": "..."
}

tasks: {
    "title": "task title",
    "description": "free-text description, defaults to empty string",
    "project_id": "the id of the project from projects collection",
    "project_name": "denormalised from projects",
    "client_id": "denormalised from the project's client",
    "client_name": "denormalised from the project's client",
    "parent_task_id": "id of the parent task for sub-tasks | null",
    "status": "todo | in_progress | done",
    "priority": "low | medium | high | urgent",
    "due_date": "YYYY-MM-DD | null",
    "attachments": [
        {
            "name": "file_name",
            "gcs_url": "public url pointing to the gcs"
        }
    ],
    "datetime_inserted": "...",
    "datetime_updated": "..."
}

trackers: {
    "title": "tracker title",
    "start_time": "ISO-8601 datetime",
    "end_time": "ISO-8601 datetime | null — null means the tracker is still active",
    "notes": "free-text notes | null",
    "tasks": [
        {
            "task_id": "...",
            "task_title": "denormalised from tasks",
            "project_name": "denormalised from tasks",
            "client_name": "denormalised from tasks"
        }
    ],
    "datetime_inserted": "...",
    "datetime_updated": "..."
}

sessions (UI: Time Entries): {
    "task_id": "the id of the task from tasks collection",
    "task_title": "denormalised from tasks",
    "project_id": "denormalised from the task",
    "project_name": "denormalised from the task",
    "client_id": "denormalised from the task",
    "client_name": "denormalised from the task",
    "tracker_id": "optional link to a tracker | null",
    "start_time": "ISO-8601 datetime",
    "end_time": "ISO-8601 datetime | null — null means the entry is still running",
    "hours": "manual override of the billable hours | null — see below",
    "billable": "true | false, defaults to true",
    "invoice_id": "set when the entry is pulled into an invoice | null",
    "invoice_number": "denormalised invoice number for display | null",
    "notes": "free-text notes | null",
    "datetime_inserted": "...",
    "datetime_updated": "..."
}

`invoice_id` and `invoice_number` are informational back-links. They live on the document and
appear in the API response, but the sessions router never writes them and they cannot be set
through `POST /sessions` or `PUT /sessions/{id}`. Only the invoices router sets them, and being
linked to an invoice never makes a time entry harder to edit or re-use.

invoices: {
    "invoice_number": "INV-2026-001",
    "client_id": "the id of the client from clients collection",
    "client_name": "denormalised from clients",
    "project_ids": ["derived from the lines, informational"],
    "project_names": ["derived from the lines, informational"],
    "status": "draft | sent | paid | void",
    "issue_date": "YYYY-MM-DD, defaults to today in SGT",
    "due_date": "YYYY-MM-DD | null, defaults to issue_date + default_due_days",
    "period_start": "YYYY-MM-DD | null — the range the time entries were pulled from",
    "period_end": "YYYY-MM-DD | null",
    "currency": "from the client, else settings.default_currency",

    "lines": [
        {
            "line_id": "uuid4, generated when absent",
            "task_id": "... | null for a manually added line",
            "task_title": "snapshot — never re-resolved from the task",
            "project_id": "... | null",
            "project_name": "snapshot",
            "description": "editable; defaults to task_title",
            "date_from": "YYYY-MM-DD | null",
            "date_to": "YYYY-MM-DD | null",
            "hours": "editable",
            "rate": "editable; resolved default snapshotted at build time",
            "amount": "server-computed as hours × rate — never accepted from the client",
            "session_ids": ["provenance; empty for a manual line"]
        }
    ],

    "subtotal": "server-computed",
    "discount_type": "percent | amount | null",
    "discount_value": "the percentage or the flat amount",
    "discount_amount": "server-computed",
    "tax_label": "e.g. GST | null",
    "tax_percent": "applied to the discounted subtotal",
    "tax_amount": "server-computed",
    "total": "server-computed; may be negative — see below",

    "notes": "free-text | null",
    "payment_terms": "e.g. Net 14 | null",
    "bill_to": "snapshot of client name + billing address, newline separated",
    "issued_by": {
        "business_name": "snapshot from settings/invoice",
        "address": "snapshot",
        "email": "snapshot"
    },
    "datetime_inserted": "...",
    "datetime_updated": "..."
}

settings/invoice — a singleton document, created with defaults on first read: {
    "business_name": "", "address": "", "email": "", "logo_url": null,
    "default_currency": "SGD",
    "default_payment_terms": "Net 14",
    "default_due_days": 14,
    "default_tax_label": "GST",
    "default_tax_percent": 0.0,
    "default_rate": 0.0,
    "invoice_prefix": "INV",
    "reset_sequence_yearly": true,
    "datetime_inserted": "...",
    "datetime_updated": "..."
}

settings/invoice_counter — a second singleton, read and written inside a Firestore
transaction so two simultaneous invoice creates cannot claim the same number: {
    "year": 2026,
    "seq": 12
}

The number is formatted `{invoice_prefix}-{year}-{seq:03d}` → `INV-2026-013`. The sequence
starts at 1, and restarts at 1 on a year change when `reset_sequence_yearly` is set.

### Why invoices snapshot instead of referencing

`bill_to`, `issued_by`, every line's `task_title` and `project_name`, and every `rate` and
`amount` are **copied onto the invoice when it is created**, not looked up when it is read.

That is the whole point. Renaming a client, raising a project's rate, editing the issuer details
in settings, or deleting the client outright must never change what a historical invoice says —
it is a record of what was billed, not a live view. Anything rendering an invoice must use the
stored values and re-resolve nothing; `InvoicePrintView.tsx` does no arithmetic at all for the
same reason.

### Money fields are server-owned

`amount` on each line, plus `subtotal`, `discount_amount`, `tax_amount`, and `total`, are
recomputed by the server on every write from `hours`, `rate`, and the discount/tax settings.
Client-supplied totals are ignored — the create/update line schema has no `amount` field at all.

The arithmetic runs in `Decimal` built from the **string** form of each value (so `1.005` rounds
to `1.01`, not `1.00`), each line is quantised to 2 dp *before* being summed, and tax applies to
the **discounted** subtotal. `front/src/lib/money.ts` reimplements this exactly for the live
totals in the invoice builder; the two must stay in sync. See `ReadMe.md` → Money math.

**A discount larger than the subtotal is not clamped** and produces a negative total. That is
deliberate — the user owns their numbers, the UI warns without blocking, and the invoice stores
and prints the negative figure as computed.

### Hours: computed vs. overridden

`sessions` carries two hour-ish values and a third that is derived from them. Only `hours` is
stored as a user-owned value.

| Field | Stored? | Meaning |
|---|---|---|
| `duration_minutes` | No — computed on read | Whole minutes between `start_time` and `end_time`; `null` while running |
| `hours` | **Yes** | Manual override entered by the user; `null` means "use the timer" |
| `effective_hours` | No — computed on read | The value invoicing actually bills |

Resolution rule, implemented once in `compute_effective_hours()` in `back/routers/sessions.py`
and shared with anything that bills time:

```
effective_hours = round(hours, 2)                  if hours is not null
                = round(duration_minutes / 60, 2)  if end_time is set
                = 0.0                              otherwise
```

An explicit `hours: 0.0` is a real user choice and is preserved — it is not treated as unset.

**The timer never locks the hours.** No endpoint rejects an `hours` value for disagreeing with
`start_time`/`end_time`, and a time entry that already carries an `invoice_id` stays fully
editable. The only rejected value is a negative one, which is a data error rather than a
judgement call.

### Clearing optional fields on update

Two conventions, split by field type:

- **String fields** are cleared by sending the literal string `"null"` —
  e.g. `PUT /sessions/{id}` with `{"end_time": "null"}` clears `end_time`. On invoices this
  covers `due_date`, `notes`, `payment_terms`, `discount_type`, and `tax_label`; on settings,
  `logo_url`.
- **Nullable numeric fields** (`sessions.hours`, `clients.default_rate`, `projects.rate`,
  `invoices.discount_value`, `invoices.tax_percent`) are cleared by sending a real JSON `null`.
  Their handlers test `if "<field>" in payload.model_fields_set`, so omitting the key leaves the
  stored value unchanged while an explicit `null` writes `None`.

The numeric convention is why `requirements.txt` pins `pydantic>=2` — `model_fields_set` is
Pydantic v2 API. On Pydantic v1 the attribute is `__fields_set__` and clearing would silently
break.

## Sample Data:

### Model:
Planner: Sonnet 4.6 Agent

### Goal:
❯ Okay tell me first, is it fine to implement now the @files/phone_channel/PhoneChannelImplementationPlan.md? With just placeholders for the mean time? Or like responses that this     
shall be implemented in the future? The approval to use Chime SDK is on it's way for now. 

### Output:
● Yes, it's a clean split — here's the breakdown:                                                                                                                                       
                                                                                                                                                                                        
  Can be fully implemented now (no Chime dependency):                                                                                                                                   
  - Phase 1 — Model fields (phone_number, phone_number_sid, phone_provisioning_status)                                                                                                  
  - Phase 5 — API changes (AgentCreate, AgentResponse, DELETE cleanup logic)                                                                                                            
  - Phase 6 — Frontend types                                                
  - Phase 7 — OnboardingModal Phone Channel section                                                                                                                                     
  - Phase 8 — Agents.tsx phone row                                                                                                                                                      
                                                                                                                                                                                        
  Stub with a placeholder:                                                                                                                                                              
  - Phase 3 — chime_service.py — create the file with the correct function signatures, but have each function raise NotImplementedError("Chime SDK approval pending") or return a mock  
  response for local dev.                                                                                                                                                               
  - Phase 4 — phone_provisioning_task.py — same: wire it up, but have it immediately set status = "failed" with a log message like "Chime SDK not yet configured".                      
                                                                                                                                                                                        
  Skip entirely for now:                                                                                                                                                                
  - Phase 2 — AWS infra (console/Terraform work, nothing to code)                                                                                                                       
                                                                                                                                                                                        
  This way the full data flow and UI exist and are testable end-to-end. When Chime approval lands, Storm Spirit only needs to fill in chime_service.py — everything else is already     
  wired.                                                                                                                                                                                
                                                                  
  Want me to dispatch Storm Spirit + Void Spirit now with this scope?

### Time Entry:
```json
{
  "task_id": "abc123",
  "task_title": "Fix checkout bug",
  "project_name": "Website Redesign",
  "client_name": "Acme Corp",
  "start_time": "2026-07-03T09:00:00+08:00",
  "end_time": "2026-07-03T10:30:00+08:00",
  "hours": null,
  "billable": true
}
```

Read back as `duration_minutes: 90`, `effective_hours: 1.5`. Setting `hours: 6.75` on the same
entry leaves `duration_minutes` at 90 and makes `effective_hours` 6.75.
