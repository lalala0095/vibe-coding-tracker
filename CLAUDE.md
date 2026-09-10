# CLAUDE.md — Vibe Coding Tracker

Guidance for Claude Code when working in this repository.

## What this app is

A personal tracker for AI-assisted consulting work. Hierarchy:

```
Client → Project → Task (self-nesting via parent_task_id)
                     ├── goals    (AI prompt/output records — labelled "Sessions" in the UI)
                     └── sessions (time entries: start/end — labelled "Time Entries" in the UI)
Tracker → groups tasks and time entries into a work block
```

Not a git repository. There is no test suite and no linter configured.

## Stack

| Layer | Tech |
|---|---|
| Backend | FastAPI (Python), deployed to Cloud Run (`back/deploy.sh`) |
| Frontend | React 18 + TypeScript + Vite + Tailwind, deployed to Vercel |
| Database | GCP Firestore (native mode) |
| Files | Google Cloud Storage |
| Auth | Google Sign-In → backend exchanges the Google ID token for a session JWT (`/auth/login`); the frontend stores it in `localStorage` under `session_token` |

## Layout

```
back/
  main.py                 # app, CORS, /health, router registration
  auth.py                 # get_current_user dependency
  routers/                # auth_router, models, goals, clients, projects, tasks, trackers, sessions
  services/               # firestore_service (singleton), storage_service
front/src/
  api.ts                  # every HTTP call — axios instance with a bearer interceptor
  types.ts                # every wire type
  auth.tsx                # AuthProvider / useAuth
  App.tsx                 # routes
  pages/                  # LoginPage, DashboardPage, TasksPage, TrackersPage, ModelsPage, ClientsProjectsPage
  components/             # GoalCard/Form/Modal/Panel, TaskForm/Modal/Panel, ModelSelector, ProtectedRoute
```

## Commands

```bash
cd front && npm run dev      # Vite dev server
cd front && npm run build    # tsc && vite build — the only type check available, run it before declaring done
cd back  && uvicorn main:app --reload --port 8080
cd back  && ./deploy.sh      # Cloud Run
```

## Conventions — follow these

**Backend router file shape.** Every router in `back/routers/` follows the same layout, in this order: imports → `router = APIRouter(prefix=..., tags=[...])` → `SGT = pytz.timezone("Asia/Singapore")` → a "Pydantic schemas" banner comment → a "Helpers" banner → an "Endpoints" banner. Match it exactly when adding a router.

- Timestamps: `_now_sgt()` returning `datetime.now(tz=SGT).isoformat()`. Every document carries `datetime_inserted`, and mutable ones also carry `datetime_updated`.
- Every endpoint takes `_user: Annotated[dict, Depends(get_current_user)]`.
- Doc → response conversion goes through a `_doc_to_x(doc)` helper using `data.get(key, default)` for every field, so older documents missing new fields never 500.
- **Denormalise names.** A project stores `client_name`, a task stores `project_name`/`client_name`, a session stores `task_title` and the whole project/client chain. Refresh them when the parent id changes.
- Optional fields are cleared by sending the literal string `"null"` (see `sessions.py` update).
- Child arrays are embedded on the parent document (`task.attachments`, `tracker.tasks`) rather than in subcollections.
- Firestore composite indexes are avoided where possible by applying the equality filter in Firestore and sorting in Python (`sessions.py:146`).
- 404 with a message shaped `f"Project '{project_id}' not found."`.

**Frontend.**
- All HTTP goes through `front/src/api.ts`. Components never call axios directly.
- All wire types live in `front/src/types.ts`.
- Tailwind, dark theme: `bg-slate-950` page, `bg-slate-900` cards, `border-slate-700/800`, `text-slate-100/400/500`, violet/indigo accents, blue primary buttons.
- Pages own their data fetching in a `useCallback` + `useEffect` pair with `loading` / `error` state.
- Multi-pane pages use the two-column list-plus-detail layout of `TrackersPage.tsx`.

## Traps

**"Session" is overloaded.** The UI word "Sessions" refers to the `goals` collection (AI prompt/output). The `sessions` collection is time entries and must be labelled **"Time Entries"** in any new UI. Read `InvoicingPlan.md` §2.2 before touching either.

**`duration_minutes` is computed on read**, not stored (`back/routers/sessions.py:63`). Hours must be user-editable — see the next section.

**The nav header is duplicated across six pages.** Adding a nav link currently means editing all six. `InvoicingPlan.md` WS-4 extracts it into `components/AppNav.tsx`; do that before adding links.

**A tracker carries no billable time, and reaches a rate only through its tasks.** `Tracker` has a span but no `project_id`. Its `TrackerTaskRef` does carry `task_id` (the names beside it are denormalised display copies), so the only route from tracker hours to a rate is `task_id` → `Task.project_id` → project → client — the hop `bill_tracker` makes server-side in `_resolve_tracker_tasks`, and the one `weeklySummary.ts` makes client-side. A feature that prices tracker time and does not load the task list will silently report hours with no money against them.

**A tracker reaches an invoice by two routes, and code that knows only one under-reports.** `POST /trackers/{id}/bill` turns the span into `sessions` rows — but an invoice line can also carry a `tracker_id` and bill the span **directly**, creating no time entry at all (`Tracker.invoice_ids` records that claim). So "is this tracker billed?" cannot be answered from `sessions` alone; `weeklySummary.ts` reads non-void invoice lines too. Voiding does not release the claim, and a void invoice is deliberately *not* counted as billed — those hours genuinely still need invoicing.

Hours become *invoiceable* only once `POST /trackers/{id}/bill` turns the span into `sessions` rows. So anything reporting hours must decide what to do about a stopped-but-unbilled tracker; reading time entries alone reports low, which is what the weekly summary used to do. It now counts both, and the rule that keeps it honest is: **a tracker contributes `max(0, span − hours already billed against it)`**. Fully billed → nothing (the entries carry it); billed in part → the remainder; billed for more than it ran → nothing, never a subtraction. `front/src/lib/weeklySummary.ts` is the reference for this, and its header is the full argument.

**`ReadMe.md` is stale.** It documents only models and goals and predates clients, projects, tasks, trackers, and sessions. Trust the code, not the ReadMe.

## Product principle — no locking

The owner tracks time but must keep manual control. **Timer-derived values are defaults, never constraints.** Do not add read-only or disabled states to hours, rates, dates, or amounts — not on a running timer, not on a sent invoice, not on an already-invoiced time entry. Warn visually; never block the edit.

## Invoicing

**Implemented.** `InvoicingPlan.md` remains the design reference — data model, API surface, money-math rules, and §11's outstanding runtime verification debts.

Design decisions (do not re-litigate):
- One invoice line **per task** — title, date range, total hours, rate, amount.
- Rate precedence: **client default → project rate → invoice-line override**, resolved once and **snapshotted onto the line**, so changing a rate later never rewrites a past invoice. `bill_to`, `issued_by` and per-line `task_title` are snapshots for the same reason.
- Editable hours at **both** the time-entry level and the invoice-line level.
- Status + auto numbering, print/PDF via CSS, tax + discount, notes + payment terms.

### Money rules — easy to break, hard to notice

`back/services/invoice_service.py` and `front/src/lib/money.ts` implement the same arithmetic and **must stay in sync**. Both are unit-tested against the same cases. If you change one, change and re-verify the other.

1. Build `Decimal` from `str(value)`, never the float — `Decimal(1.005)` rounds *down*. In JS, plain `toFixed` has the identical flaw: `(1.005).toFixed(2)` is `"1.00"`.
2. Quantise each line to 2dp **before** summing, not sum-then-round.
3. Tax applies to the **discounted** subtotal, not the raw one.
4. A discount larger than the subtotal is **deliberately not clamped** and yields a negative total. This is intentional, not a bug — the server is a pure calculator and must not silently rewrite input. The frontend warns loudly; it does not block or clamp.

The server always recomputes every money field; client-supplied totals are ignored on write.

### Do not recompute in the print view

`InvoicePrintView` renders the invoice's **stored** money values verbatim. A historical invoice must print the numbers it was saved with, even after rates or settings change.
