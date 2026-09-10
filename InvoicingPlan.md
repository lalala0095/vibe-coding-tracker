# Invoicing Scope — Implementation Plan

Status: **approved plan, not yet implemented**
Owner: team leader (Claude) → dispatched to sub-agents in the workstreams below.

---

## 1. Goal

Add invoicing to Vibe Coding Tracker:

- Build an invoice from a **client + date range**, listing **tasks**, the **dates** worked, and the **hours** spent.
- **Hours are always editable.** The timer never locks a value. Anywhere hours appear, the user can overwrite them.
- **Rates are shown on Projects**, with a client-level default and a per-invoice-line override.
- Invoice supports numbering, status, tax/discount, notes/payment terms, and print-to-PDF.

### Governing principle — no locking

The user explicitly asked that the timer must not lock hours. Apply this consistently across the whole scope:

- Timer-derived duration is a **default**, never a constraint.
- A sent or paid invoice stays **editable** — show a warning badge, do not disable inputs.
- A session already attached to an invoice can still be edited and re-used — show "already invoiced", do not block.

No sub-agent may introduce a read-only/disabled state on an hours, rate, date, or amount field.

---

## 2. Two blocking problems found during survey

### 2.1 `duration_minutes` is derived, not stored

`back/routers/sessions.py:63` computes duration from `start_time`/`end_time` on every read. There is no persisted, user-owned hours value. Fix: add a nullable `hours` override on the session document.

Resolution rule (single source of truth, used by backend and frontend):

```
effective_hours = session.hours              if session.hours is not None
                = round(duration_minutes/60, 2)  if end_time is set
                = 0.0                        otherwise
```

### 2.2 Naming collision: "Session" means two different things

| Collection | Contains | Current UI label | Has UI? |
|---|---|---|---|
| `goals` | AI prompt + output + model + attachments | **"Sessions"** | Yes — Dashboard, TaskPanel |
| `sessions` | `task_id`, `start_time`, `end_time`, duration | *(none)* | **No — dead API** |

The time-entry API that invoicing depends on is fully implemented in the backend and completely unused by the frontend.

**Decision:**
- Backend collection and route stay `sessions` / `/sessions` (no data migration, no breaking change).
- The **UI label for `sessions` is "Time Entries"**. Never "Sessions".
- The existing `goals` UI keeps its current "Sessions" label. Out of scope to rename.
- In all new code, TypeScript type `TimeEntry` aliases the API `Session` shape; `front/src/types.ts` keeps `Session` as the wire type and exports `TimeEntry` for UI use.

Every sub-agent must read this section before writing code.

---

## 3. Data model

Conventions to follow (already established in this repo): denormalised name fields, ISO-8601 SGT strings via `_now_sgt()`, arrays embedded on the parent doc (as in `tracker.tasks` and `task.attachments`), `"null"` string sentinel to clear an optional field on update.

### 3.1 `clients` — add

| Field | Type | Notes |
|---|---|---|
| `default_rate` | `float \| null` | Fallback hourly rate |
| `currency` | `str` | Default `"SGD"` |
| `billing_email` | `str \| null` | |
| `billing_address` | `str \| null` | Multi-line, used in invoice Bill-To |

### 3.2 `projects` — add

| Field | Type | Notes |
|---|---|---|
| `rate` | `float \| null` | Overrides the client default |

### 3.3 `sessions` (UI: Time Entries) — add

| Field | Type | Notes |
|---|---|---|
| `hours` | `float \| null` | **Manual override.** `null` = fall back to computed |
| `billable` | `bool` | Default `true` |
| `invoice_id` | `str \| null` | Set when pulled into an invoice — informational only |
| `invoice_number` | `str \| null` | Denormalised for display |

Response gains `effective_hours: float` (computed per §2.1). `duration_minutes` stays as-is for backwards compatibility.

### 3.4 `invoices` — new collection

```jsonc
{
  "invoice_number": "INV-2026-001",
  "client_id": "...", "client_name": "Acme Corp",
  "project_ids": ["..."], "project_names": ["Website Redesign"],  // denormalised, informational
  "status": "draft",              // draft | sent | paid | void
  "issue_date": "2026-08-03",     // YYYY-MM-DD
  "due_date": "2026-08-17",       // YYYY-MM-DD | null
  "period_start": "2026-07-01",   // range used to pull time entries
  "period_end": "2026-07-31",
  "currency": "SGD",

  "lines": [
    {
      "line_id": "uuid4",
      "task_id": "...",           // null for a manually added line
      "task_title": "Fix checkout bug",
      "project_id": "...", "project_name": "Website Redesign",
      "description": "Fix checkout bug",   // editable, defaults to task_title
      "date_from": "2026-07-03",           // editable
      "date_to":   "2026-07-07",           // editable
      "hours": 6.75,                       // editable
      "rate": 85.0,                        // editable; resolved default at build time
      "amount": 573.75,                    // server-computed, stored
      "session_ids": ["..."]               // provenance; empty for manual lines
    }
  ],

  "subtotal": 743.75,
  "discount_type": "percent",     // percent | amount | null
  "discount_value": 0.0,
  "discount_amount": 0.0,
  "tax_label": "GST",
  "tax_percent": 9.0,
  "tax_amount": 66.94,
  "total": 810.69,

  "notes": "...",
  "payment_terms": "Net 14",
  "bill_to": "Acme Corp\n123 Example Rd\nSingapore",   // snapshot at creation
  "issued_by": { "business_name": "...", "address": "...", "email": "..." },  // snapshot

  "datetime_inserted": "...", "datetime_updated": "..."
}
```

Lines are an embedded array — consistent with `tracker.tasks`. No subcollection.

### 3.5 `settings` — new singleton doc `settings/invoice`

Issuer details and defaults, snapshotted onto each invoice at creation so historical invoices never change when settings do.

```jsonc
{
  "business_name": "...", "address": "...", "email": "...", "logo_url": null,
  "default_currency": "SGD",
  "default_payment_terms": "Net 14",
  "default_due_days": 14,
  "default_tax_label": "GST",
  "default_tax_percent": 0.0,
  "default_rate": 0.0,
  "invoice_prefix": "INV",
  "reset_sequence_yearly": true
}
```

Separate doc `settings/invoice_counter`: `{ "year": 2026, "seq": 12 }`, incremented in a **Firestore transaction** so concurrent creates cannot collide.

Number format: `{prefix}-{year}-{seq:03d}` → `INV-2026-013`.

---

## 4. Rate resolution

Resolved **once, at line-build time**, then stored on the line. Editing a project's rate later does not silently rewrite existing invoices.

```
line.rate  ??  project.rate  ??  client.default_rate  ??  settings.default_rate  ??  0.0
```

Implemented in `back/services/rate_service.py`, taking **already-fetched dicts rather than ids** so the invoice builder incurs no per-line Firestore reads:

```python
def resolve_rate(line_rate, project_data, client_data, settings_default_rate=None) -> float
def resolve_currency(client_data, settings_default_currency="SGD") -> str
```

An explicit `0.0` is a real value, not a fallback trigger — `resolve_rate(0.0, {"rate": 85.0}, ...)` returns `0.0`. This matches the zero-rate edge case in §10.

### Clearing nullable numeric fields

The repo's `"null"` string sentinel only works for string fields. For nullable **numeric** fields — `clients.default_rate`, `projects.rate`, `sessions.hours` — use Pydantic v2's `model_fields_set` to distinguish "field absent" (leave unchanged) from "explicitly `null`" (write `None`). Use this one mechanism everywhere; do not introduce a second convention such as a `-1` magic value or an `_UNSET` object. String fields keep the existing `"null"` sentinel.

---

## 5. Money math (must be identical backend and frontend)

- All arithmetic in `Decimal`, quantised to 2 dp with `ROUND_HALF_UP`. Store as `float` in Firestore.
- Hours rounded to 2 dp.
- **The server always recomputes `amount`, `subtotal`, `discount_amount`, `tax_amount`, and `total`.** Client-supplied totals are ignored on write.
- Order of operations:
  1. `amount = hours × rate` per line
  2. `subtotal = Σ amount`
  3. `discount_amount` = `subtotal × discount_value / 100` (percent) or `discount_value` (amount)
  4. `taxable = subtotal − discount_amount`
  5. `tax_amount = taxable × tax_percent / 100`
  6. `total = taxable + tax_amount`
- Frontend shows live totals for immediate feedback using the same order, then reconciles with the server response after save.
- Display via `Intl.NumberFormat(locale, { style: 'currency', currency })`.

### Three rules that make BE and FE agree exactly

These are not incidental — get any of them wrong and the two sides disagree by a cent on real invoices.

1. **Build `Decimal` from `str(value)`, never from the float.** `Decimal(1.005)` is the binary value fractionally *below* the half cent and rounds **down** to `1.00`; `Decimal("1.005")` rounds **up** to `1.01`. Only the string route delivers the `ROUND_HALF_UP` this spec mandates. In JS, round via a string/epsilon-safe helper rather than `toFixed` alone, which inherits the same binary-representation problem.
2. **Quantise each line to 2 dp *before* summing** — do not sum at full precision and round once at the end. Three lines of `0.005` must total `0.03`, not `0.02`. This is what makes the stored per-line `amount` re-add to the stored `subtotal`, which the frontend depends on.
3. **A discount larger than the subtotal is left literal — no clamp.** `discount_value: 150` against a `100` subtotal yields `taxable = −50` and a negative total. The server is a pure calculator and must not silently rewrite the user's input; that is the §1 no-locking principle applied to arithmetic. **The frontend must warn loudly and visibly** when `discount_amount > subtotal`, but must not block the entry or clamp the value. WS-7 implements the identical rule.

---

## 6. API surface

### New — `back/routers/invoices.py`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/invoices?client_id=&status=` | List, sorted `issue_date` desc |
| `GET` | `/invoices/{id}` | Single invoice |
| `POST` | `/invoices/preview` | **Build draft lines without persisting.** Body: `client_id`, `project_ids[]?`, `period_start`, `period_end`, `include_invoiced=false`. Groups billable time entries by `task_id` → one line per task with `date_from`/`date_to` = min/max entry date, `hours` = Σ effective hours, resolved `rate`, `session_ids[]` |
| `POST` | `/invoices` | Create. Accepts lines as edited by the user; server recomputes money and assigns the number transactionally; batch-writes `invoice_id`/`invoice_number` onto referenced sessions |
| `PUT` | `/invoices/{id}` | Full update of lines + meta; recompute money; reconcile session back-links (clear removed, set added) |
| `PATCH` | `/invoices/{id}/status` | Status transition |
| `DELETE` | `/invoices/{id}` | Delete + clear session back-links |

### New — `back/routers/settings.py`

| Method | Path |
|---|---|
| `GET` | `/settings/invoice` — returns defaults, creating the doc on first read |
| `PUT` | `/settings/invoice` |

### Modified

- `clients.py` — new fields on Create/Update/Response.
- `projects.py` — `rate` on Create/Update/Response.
- `sessions.py` — `hours`, `billable`, `invoice_id`, `invoice_number`, `effective_hours`; new list filters `client_id`, `project_id`, `date_from`, `date_to`, `billable`, `uninvoiced_only`.
- `main.py` — register both new routers.

### Firestore indexes

The invoice preview filters `sessions` by `client_id` + `start_time` range. Add a composite index on `sessions(client_id ASC, start_time ASC)` and `sessions(project_id ASC, start_time ASC)`. Document them in `ReadMe.md`; follow the existing pattern in `sessions.py:146` of filtering in Firestore then sorting in Python where it avoids an index.

---

## 7. Frontend surface

### New files

| File | Purpose |
|---|---|
| `components/AppNav.tsx` | Extracted shared header — see §7.1 |
| `pages/InvoicesPage.tsx` | Two-column list + detail, mirroring `TrackersPage.tsx` |
| `components/InvoiceBuilder.tsx` | Client + projects + date range → calls `/invoices/preview` → editable lines |
| `components/InvoiceLineTable.tsx` | Editable rows: description, date_from, date_to, hours, rate; add/remove/reorder; live totals |
| `components/InvoicePrintView.tsx` | Print-optimised invoice document |
| `components/TimeEntryList.tsx` | Time Entries for a task — list + inline add/edit |
| `components/TimeEntryForm.tsx` | start, end, **hours (editable, prefilled from start/end)**, billable, notes |
| `pages/InvoiceSettingsPage.tsx` | Business details and defaults |

### Modified

- `types.ts` — `Invoice`, `InvoiceLine`, `InvoiceStatus`, `InvoicePreviewRequest`, `InvoiceSettings`; extend `Client`, `Project`, `Session`; export `TimeEntry` alias.
- `api.ts` — invoice, settings, and extended session functions.
- `App.tsx` — routes `/invoices`, `/invoices/settings`.
- `ClientsProjectsPage.tsx` — rate + currency + billing fields; show rate in the project list.
- `components/TaskPanel.tsx` — mount `TimeEntryList` above the existing "Sessions" (goals) block, labelled **Time Entries**, showing total hours for the task.
- `index.css` — `@media print` rules.

### 7.1 Nav duplication

The header block is copy-pasted across six pages (`DashboardPage`, `TasksPage`, `TrackersPage`, `ModelsPage`, `ClientsProjectsPage`, and the new page). Adding an Invoices link means editing all of them. Extract `components/AppNav.tsx` taking an `active` prop **first**, in WS-4, so later workstreams touch one file instead of six. This is the only refactor authorised in this scope.

### 7.2 Print / PDF

Browser print-to-PDF via CSS. No new dependencies, no backend PDF renderer.

- Route renders `InvoicePrintView` at A4 width with `@page { size: A4; margin: 14mm; }`.
- `print:hidden` on nav, buttons, and inputs; line table renders as static text when printing.
- Verify page-break behaviour on a long line table (`break-inside: avoid` on rows).

---

## 8. Workstreams

Dependency order. WS-0 is done by the team leader and gates everything.

```
WS-0 contracts ──┬── WS-1 rates (BE) ──────┐
                 ├── WS-2 hours (BE) ──────┼── WS-3 invoices (BE) ──┐
                 └── WS-4 shell (FE) ──┬── WS-5 rates (FE)          │
                                       ├── WS-6 time entries (FE) ──┤
                                       └────────────────────────────┴── WS-7 invoices (FE) ── WS-8 print ── WS-9 docs
```

| ID | Title | Depends on | Deliverable |
|---|---|---|---|
| **WS-0** | Contracts | — | Pydantic schemas + `types.ts` additions landed first so no two agents edit the same shape. Team leader. |
| **WS-1** | Backend: rates | WS-0 | `clients.py`, `projects.py`, `services/rate_service.py` |
| **WS-2** | Backend: editable hours | WS-0 | `sessions.py` — `hours` override, `billable`, invoice back-links, new filters |
| **WS-3** | Backend: invoices | WS-1, WS-2 | `routers/invoices.py`, `routers/settings.py`, `services/invoice_service.py` (numbering txn + money math), `main.py` wiring |
| **WS-4** | Frontend: shell | WS-0 | `AppNav.tsx` extraction across 6 pages, routes, `types.ts`, `api.ts` |
| **WS-5** | Frontend: rates | WS-1, WS-4 | Rate/currency/billing fields in `ClientsProjectsPage.tsx` |
| **WS-6** | Frontend: Time Entries | WS-2, WS-4 | `TimeEntryList`, `TimeEntryForm`, `TaskPanel` integration |
| **WS-7** | Frontend: invoices | WS-3, WS-4 | `InvoicesPage`, `InvoiceBuilder`, `InvoiceLineTable`, `InvoiceSettingsPage` |
| **WS-8** | Print view | WS-7 | `InvoicePrintView`, print CSS |
| **WS-9** | Docs + verification | all | Update `ReadMe.md` + `MyTrackerFormat.md`, index list, manual test pass |

Parallel batches: **{WS-1, WS-2, WS-4}** → **{WS-3, WS-5, WS-6}** → **{WS-7}** → **{WS-8, WS-9}**.

---

## 9. Invoice build flow (user's path)

1. Log work: Tasks → open a task → **Time Entries** → add entry. Start/end prefill hours; **the hours field is always editable**.
2. Invoices → **New** → pick client, optionally narrow to projects, pick a period.
3. Preview loads one line per task: title, dates worked, total hours, resolved rate, amount.
4. Edit anything — description, dates, hours, rate. Add manual lines. Delete lines.
5. Set discount / tax / notes / payment terms / due date.
6. Save → number assigned, referenced entries flagged as invoiced.
7. Print → PDF. Mark **sent**, then **paid**.

---

## 10. Edge cases to handle

- Running time entry (`end_time = null`) with no manual hours → `effective_hours = 0`, excluded from preview by default, surfaced as a warning "1 entry still running".
- Entry spanning midnight → dated by `start_time`'s local date.
- Task with entries across two projects → group by `(task_id, project_id)`, not `task_id` alone.
- Task deleted after invoicing → line keeps its snapshot `task_title`; never re-resolve from the task doc.
- Project rate changed after invoicing → existing invoices unaffected (rate is snapshotted).
- Zero-hour or zero-rate lines → allowed, shown, contribute 0.
- Deleting an invoice → clear `invoice_id`/`invoice_number` on its sessions in a batch write.
- Client deleted → invoices retain the `bill_to` snapshot and remain readable.
- Timezone: all dates rendered in SGT to match the rest of the app.

---

## 11. Open verification debts

Neither `fastapi` nor `pydantic` is installed in the dev environment and there is no venv, so backend routers currently have **byte-compile verification only** — no Pydantic model validation, no app startup, no Firestore round-trip. Modules without framework imports (`rate_service.py`, `compute_effective_hours`) are genuinely unit-tested.

Clear these the moment a runtime is available:

- [ ] Import every modified router (`clients`, `projects`, `sessions`) and start the FastAPI app.
- [ ] `PUT /projects/{id}` with `{"rate": null}` → confirm it clears the rate rather than 500-ing. This is the one check that proves the `model_fields_set` convention works on the installed Pydantic. Same for `PUT /clients/{id}` with `{"default_rate": null}` and `PUT /sessions/{id}` with `{"hours": null}`.
- [ ] Confirm a partial update (one field only) leaves every other field unchanged — a mis-written presence guard would silently null out data.
- [ ] Confirm legacy documents written before these fields existed still deserialize.
- [ ] `POST /invoices/preview` against real data — confirm the single-equality-filter query needs no composite index, and that a task worked under two projects yields two lines rather than one.
- [ ] **Create an invoice, delete one of its sessions, then `PUT` the invoice.** A batched `update()` against a deleted document fails the *entire* batch, so a session deleted after invoicing could otherwise break an unrelated invoice save. `_sync_session_links` pre-filters with a bulk existence check to survive this; that pre-filter is unit-tested against a stub but unproven against real Firestore. This is the failure mode least pleasant to discover in production.
- [ ] **Cross-invoice back-link ownership.** Create invoice A containing time entry S. Preview with `include_invoiced=true` and create invoice B also containing S. Edit A to drop S. Confirm S still reads as belonging to **B**, not unlinked. This was a real defect — `_sync_session_links` cleared unconditionally, so A's edit wiped B's link and silently defeated the double-billing guard. Fixed and regression-tested against a fake Firestore; unproven against the real one.
- [ ] **Create-path clear sentinel.** `POST /invoices` with `due_date="null"` → response must have `due_date: null`, not a date `default_due_days` out. With `tax_label="null"` → the label must be empty, **not the four-character string `"null"`**. Same for `notes`, `payment_terms`, `discount_type`.
- [ ] **`currency` must never receive `"null"`.** It is non-nullable with no "no currency" meaning and no sentinel on either the create or update path, so `"null"` would be stored literally and printed on the invoice.
- [ ] Real concurrent-numbering contention — two simultaneous `POST /invoices` must not collide on an invoice number. The transaction is tested against a fake; real retry semantics are not.

`pydantic>=2` is pinned in `requirements.txt` because the update handlers rely on `model_fields_set`. If the runtime turns out to be v1, the fix is mechanical: `payload.__fields_set__` at each site.

## 12. Known limitation — an entry can sit on two invoices

The `invoice_id`/`invoice_number` back-link on a time entry is **single-valued**, but nothing stops the same entry appearing on two invoices.

Invoice lines are embedded on each invoice document, and `create_invoice` writes only its own document — it never edits another invoice. So if entry S is on invoice A and the user previews with `include_invoiced=true` and creates invoice B also containing S, **A still lists S and still bills those hours**, while `S.invoice_id` now reads B. The back-link does not merely fail to warn; it *misreports*, showing the entry as cleanly handled by B.

Mitigating factor: `include_invoiced` defaults to `false`, so the default path excludes already-invoiced entries. Reaching this state requires deliberately opting in.

**Resolution, consistent with §1:** warn, never block. Re-invoicing the same hours is sometimes legitimate (a corrected re-issue), so the user must stay able to do it.

**Shipped resolution: preview warns at build time. The back-link stays single-valued.**

`POST /invoices/preview` returns `claimed_entry_count` per line and overall, plus `claimed_by` naming the invoice numbers already claiming those entries. The builder warns before creation. Creation is never blocked.

A list-valued `sessions.invoice_ids` was considered twice and rejected: it changes the `sessions` schema, the `uninvoiced_only` semantics and the badge, and needs a migration of live documents — disproportionate for a personal tracker whose default path already excludes claimed entries.

### Accepted residual — read before trusting the "Invoiced" badge

The warning covers the moment of *building* an invoice. It does not cover the state afterwards, and two gaps remain open by choice:

1. **The badge names only the latest claimant.** If an entry is on invoices A and B, its badge reads B. Nothing on screen says it is also on A, and `uninvoiced_only` hides it from A's perspective.
2. **The user's corrective action reopens the hole.** If the user notices the duplication and removes the entry from B — the right thing to do — the back-link clears entirely. The entry then reads as never invoiced and the next preview offers it again, with no warning, even though A still bills it.

Both require deliberately enabling `include_invoiced`. Neither is detected automatically: **the safeguard against billing the same hours twice is reviewing the invoice before sending it**, not the badge.

## 13. Non-goals for this pass

- Payment collection / gateway integration.
- Recurring or scheduled invoices.
- Multi-currency conversion (currency is a per-client label, no FX).
- Emailing invoices.
- Server-side PDF generation.
- Renaming the `goals` UI label away from "Sessions".
