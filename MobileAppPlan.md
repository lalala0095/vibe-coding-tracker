# Mobile App Plan — Vibe Coding Tracker

Design reference for the Android app, in the same role `InvoicingPlan.md` plays for invoicing.
Written 2026-08-14, before any code exists.

---

## 1. What this is, and what it deliberately is not

The web app is ~14,200 lines across 10 pages. Most of it is **desk work** — invoice building,
line-item editing with drag-to-reorder, regenerate diffs, print view, clients/projects CRUD, two
settings screens. None of that gets better on a 6-inch screen, and porting the invoice editor
would mean a **third** implementation of the money rules to keep in sync with
`back/services/invoice_service.py` and `front/src/lib/money.ts`.

The phone gets the **in-the-moment** half only:

| In v1 | Stays on the web |
|---|---|
| Start / stop the tracker, see it ticking | Invoice building, editing, regenerate, print |
| Add tasks to the running block | Payments and FX |
| Turn a tracker into time entries | Clients & projects CRUD |
| Log / edit / delete a time entry | Invoice settings, tracker settings |
| Browse tasks, tap to cycle status | AI Sessions (goals) and models |
| Quick-add tasks, including paste-bulk | Attachments / file upload |

**Consequence worth stating plainly: v1 does no money arithmetic.** No `money.ts` port, no third
copy of the decimal rules, no risk of the three drifting. The only aggregation on screen is a
display-only sum of hours (§7.4).

---

## 2. Established facts this plan is built on

Verified against the code and the local machine, not assumed.

**Backend** — FastAPI on Cloud Run at `https://vibe-coding-tracker-api-pm5rd5kdya-as.a.run.app`.
Ten routers, all Bearer-JWT guarded except `/health` and `/auth/*`. `back/auth.py` returns **401
when the token is missing** and **403 when it is expired or invalid** — a mobile interceptor must
handle both. Every list endpoint is unpaginated. CORS is irrelevant to a native client.

**Auth** — `POST /auth/login` takes `{id_token}`, verifies it with
`id_token.verify_oauth2_token(..., audience=GOOGLE_CLIENT_ID)` — a **single** audience, the web
client ID — and returns a self-issued HS256 JWT valid **7 days**. There is no refresh endpoint.

**Local toolchain** — Node 22.22, `eas-cli` 21.0.1 installed and logged in as `lalala0095`
(Owner). **No Java and no Android SDK on this machine**, so every build is a cloud build on EAS.
That is fine; it is also not optional.

**Versions on npm today** — Expo SDK **57.0.12** (`latest`), SDK 56.0.19 available as fallback;
`@react-native-google-signin/google-signin` **16.1.4**.

**Repo shape** — the parent folder is not a git repo. `back/` and `front/` are separate checkouts
of `github.com/lalala0095/vibe-coding-tracker` on branches `back` and `front`.

---

## 3. Where the code lives

A third sibling checkout, following the existing pattern exactly:

```
vibe-coding-tracker/
  back/     → branch `back`
  front/    → branch `front`
  mobile/   → branch `mobile`   ← new
```

Same remote, orphan branch `mobile`, so `mobile/` never carries the web or server source.

---

## 4. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Expo SDK 57, React Native, TypeScript | Required by the EAS/APK target |
| Navigation | `expo-router` (file-based) | Maps 1:1 onto the route table `App.tsx` already uses |
| Styling | NativeWind v4 | The same `bg-slate-950` / `bg-slate-900` / `border-slate-800` / `text-slate-100` / violet + indigo tokens carry over verbatim; class names stay greppable against `front/` |
| HTTP | `axios` + interceptors | Same shape as `front/src/api.ts` |
| Auth | `@react-native-google-signin/google-signin` 16 | See §5 — the only option that needs **zero backend change** |
| Token storage | `expo-secure-store` | It is a bearer credential; `AsyncStorage` is plaintext on disk |
| Dates | Hand-rolled `lib/sgt.ts` | See §7.3 — no date library, matching `front/` |
| State | `useState` / `useCallback` / Context | Matching `front/`; no Redux, no query library |

**NativeWind risk.** NativeWind v4 against SDK 57 with the New Architecture is the one piece of
this stack I cannot verify without installing it. Task A (§8) proves it renders a styled screen
before anything else is built on top. If it fights the toolchain, the fallback is a single
`theme.ts` exporting the same palette as `StyleSheet` objects — same colours, more verbose, no
schedule impact past the first task.

---

## 5. Google Sign-In — the one genuinely hard part

The backend verifies the Google ID token against **one** audience: the web `GOOGLE_CLIENT_ID`.
So the phone must produce an ID token whose `aud` is that same web client ID.

`@react-native-google-signin/google-signin` does exactly this: configure it with
`webClientId: <the existing GOOGLE_CLIENT_ID>`, and `signIn()` returns an `idToken` minted for the
**web** client. That token goes to `POST /auth/login` unchanged and verifies first try.

**→ Zero backend changes. `back/` is not touched by this project at all.**

### The blocking external step

Google will not complete a native sign-in unless an **Android OAuth client** exists in the same
GCP project, registered with the app's package name *and* the SHA-1 of the signing certificate.
That client ID is never referenced in our code — its only job is to authorise the handshake.

Order of operations, and it cannot be reordered:

1. Fix the Android package name (§9) — it is baked into the OAuth client and is painful to change later.
2. Run the first EAS build so EAS generates and stores the keystore.
3. `eas credentials` → read the SHA-1 fingerprint.
4. **In the GCP Console** (this is yours, not mine — I have no console access): APIs & Services →
   Credentials → Create OAuth client ID → Android → paste package name + SHA-1.
5. Rebuild, install, sign in.

Until step 4 is done the APK installs and runs but sign-in fails. That is expected, not a bug.

### Session lifetime

The JWT lasts 7 days with no refresh endpoint. The web app just logs you out. The phone does
slightly better, and it costs almost nothing: on any **401 or 403**, drop the stored token, attempt
`signInSilently()` once, and re-exchange. If that fails, land on the sign-in screen. No new backend
surface, no token stored longer than the server honours it.

---

## 6. Screens

Three tabs plus a sign-in screen.

```
app/
  _layout.tsx            root: AuthProvider, theme, splash
  sign-in.tsx            Google button, nothing else
  (tabs)/
    _layout.tsx          bottom tab bar
    now.tsx              ← the reason the app exists
    entries.tsx
    tasks.tsx
```

### 6.1 Now

```
┌──────────────────────────────┐
│ 2026-08-14 tasks             │
│ running · 02:14:37           │
│ [ Stop tracker ]             │
│ Tasks in block:              │
│  • Fix checkout bug          │
│  • API cleanup               │
│  [ + Add task ]              │
└──────────────────────────────┘
[ Create time entries ]
```

- Active tracker from `GET /trackers?active_only=true`, elapsed time ticking client-side off
  `start_time` (one `setInterval`, cleared on blur — no background timer, no notification).
- **Start** a tracker: title pre-filled by rendering the stored template from
  `GET /settings/tracker` through the ported `lib/trackerName.ts`. Editable, exactly as on web.
- **Stop**: `PUT /trackers/{id}` with `end_time`. See §7.3 — this must **not** be `toISOString()`.
- **Add task**: existing task picker, or paste-bulk (`POST /tasks/bulk`) via ported `lib/taskPaste.ts`.
- **Create time entries**: `POST /trackers/{id}/time-entries`, even-split vs full-span, billable
  toggle, editable hours. Server computes; the phone only posts.
- No tracker running → a single large **Start tracker** button.

### 6.2 Entries

Time entries from `GET /sessions`, grouped by day, newest first, with a per-day and overall hours
total. Filter by client/project. Add (`POST /sessions`), edit (`PUT`), delete (with confirm).
Shows `effective_hours` as returned — never recomputed. An entry carrying `invoice_number` shows
that as a **badge, not a lock** (§10).

### 6.3 Tasks

Tasks from `GET /tasks`, filterable by project and status. Tap the status chip to cycle
`todo → in_progress → done` (`PUT /tasks/{id}`) — the one-tap gesture from `TasksPage`. Quick-add
a task. Sub-tasks are shown but not managed. No attachments in v1.

---

## 7. Shared code

### 7.1 Ported verbatim from `front/src/lib/`

- `trackerName.ts` (110 lines) — pure, no DOM. Copy unchanged.
- `taskPaste.ts` (108 lines) — pure. Copy unchanged.

Both become fourth/third copies of logic that already exists on the web. They are pure functions
with no external dependencies, and each will be verified against the same cases as its web
original before it ships.

### 7.1a Copied later, under the same rule

Three more libraries were copied verbatim after v1 shipped, each with a short header naming the
`diff` that proves the body is unchanged:

| File | Header | Invariant |
|---|---|---|
| `lib/week.ts` | 13 lines | `diff <(tail -n +14 src/lib/week.ts) ../front/src/lib/week.ts` |
| `lib/weeklySummary.ts` | 10 lines | `diff <(tail -n +11 src/lib/weeklySummary.ts) ../front/src/lib/weeklySummary.ts` |
| `lib/regenerate.ts` | 10 lines | `diff <(tail -n +11 src/lib/regenerate.ts) ../front/src/lib/regenerate.ts` |

Each was copied rather than ported for the same reason `money.ts` was. `weeklySummary.ts` contains a
port of `back/services/rate_service.py`'s rate chain, and a *second* hand-written port of that chain
is how the phone and the browser start quoting different money for the same week. `regenerate.ts`
decides which invoice fields are facts about the work and which are authored by the owner; a second
version of that split would silently discard a rate typed on the phone that the web would have kept.

One knowing duplication: `week.ts` carries its own `todaySgt()`, and `lib/sgt.ts` already exports one.
Both are correct and neither can drift — Singapore's offset is a constant — and preserving the
byte-identity invariant was judged worth more than removing a one-line duplicate. Prefer `sgt.ts`
for timestamp work and `week.ts` only for week arithmetic.

**`screens/invoices/detail/regenerateDraft.ts` is NOT a copy** and has no web counterpart. The web
edits `InvoiceLine[]` directly; this app edits an `InvoiceDraft` whose `hours` and `rate` are raw
text and whose rows carry a local React `key`. That adapter is the only sanctioned bridge between
the two shapes, and its delicate part is keys, not fields: a line the merge adds has `line_id: ''`,
so keying added rows off `line_id` would give every one of them the same key and React would
collapse them into a single row. Tested at 23/23, including that case.

### 7.2 `types.ts` — copied whole, not partially

The wire types are free at runtime and a partial copy is exactly how contracts drift. `mobile/src/types.ts`
is `front/src/types.ts` verbatim, including the invoice types v1 never touches. `api.ts` is the
opposite: **only** the ~20 functions the three screens actually call, so unused surface cannot rot
unnoticed.

I write both files myself (§8), because they are the wire contract.

### 7.3 `lib/sgt.ts` — the timezone rule

Everything in this system is an ISO-8601 string in **Singapore time with a `+08:00` offset**,
written by `_now_sgt()` on the server and by `datetime-local` inputs on the web.

`new Date().toISOString()` returns UTC with a `Z`. On a phone in SGT, between midnight and 08:00
that is **the previous day** — which then feeds the wrong date into invoice periods and line date
ranges.

**Rule: no mobile file may call `toISOString()` on a user-facing timestamp.** All start/end times
go through `lib/sgt.ts`, which builds `YYYY-MM-DDTHH:mm:ss+08:00` from the local calendar getters,
the same way `lib/trackerName.ts` already does for names. This is a named deliverable with its own
unit checks, not a convention I hope people follow.

> **Adjacent, and not part of this project:** `handleStopTracker` in `front/src/pages/TrackersPage.tsx`
> has this exact defect today — the web Stop button writes UTC `Z`. Building a phone Stop button
> that writes `+08:00` means the two buttons will disagree until that ~10-line fix lands. It is a
> separate call and I am not making it inside this work.

### 7.4 Hours totals are display-only

The entries screen shows summed hours. Naive float summing renders `12.299999999`. The fix is a
six-line helper that sums hours as scaled integers and formats at the end — explicitly labelled
**display-only**, explicitly **not** an implementation of the money rules, and never used for
anything billable. All billable arithmetic stays on the server, where it already is.

---

## 8. Execution — task partition

No two agents write the same file. I keep the wire contract, the timezone lib, and every
verification pass.

| # | Owner | Deliverable | Depends on |
|---|---|---|---|
| **0** | me | `mobile/` checkout on branch `mobile`, `.gitignore` before anything else exists | — |
| **A** | agent | Scaffold: `package.json`, `app.config.ts`, `eas.json`, `tsconfig.json`, `babel.config.js`, `tailwind.config.js`, `global.css`, `app/_layout.tsx`. Proves one NativeWind-styled screen renders. | 0 |
| **B** | **me** | `src/types.ts`, `src/api.ts`, `src/lib/sgt.ts` — the wire contract and the timezone rule | A |
| **C** | agent | `src/theme.ts` + UI primitives (`Screen`, `Card`, `Button`, `Field`, `Select`, `DateTimeField`, `ConfirmSheet`) | A |
| **D** | agent | `src/auth.tsx`, `app/sign-in.tsx`, secure-store session, 401/403 recovery | B, C |
| **E** | agent | `app/(tabs)/now.tsx` + tracker components + port `lib/trackerName.ts` | B, C |
| **F** | agent | `app/(tabs)/entries.tsx` + time-entry form/list | B, C |
| **G** | agent | `app/(tabs)/tasks.tsx` + task picker + port `lib/taskPaste.ts` | B, C |
| **H** | **me** | Integration, `tsc --noEmit` gate, unit checks on `sgt.ts` / `trackerName.ts` / `taskPaste.ts`, review of every diff | all |
| **I** | **me** | EAS build, credentials, APK | H |

Seven agents. **A → B → C** are serial; **D, E, F, G** run in parallel; then me.

### Verification gate

This repo has no test runner and no linter, so the gates are the same ones I have been using:

1. `npx tsc --noEmit` must be clean — the mobile equivalent of `npm run build` on `front/`.
2. The three ported pure libs get their own node-executed unit checks, run by me, against the same
   cases their web originals pass.
3. I read every diff. Agent reports are not evidence.
4. Acceptance is the APK installed on a real phone, which only you can do.

---

## 9. Build & ship

```jsonc
// eas.json
{
  "build": {
    "development": { "developmentClient": true, "distribution": "internal",
                     "android": { "buildType": "apk" } },
    "preview":     { "distribution": "internal",
                     "android": { "buildType": "apk" } },   // ← the deliverable
    "production":  { "android": { "buildType": "app-bundle" } }  // unused; Play Store only
  }
}
```

`eas build -p android --profile preview` → an APK plus an install page. EAS-managed keystore.

**Identifiers — cheap to change now, expensive after step 4 of §5:**

| | Proposed |
|---|---|
| App name | `Vibe Tracker` |
| Slug | `vibe-coding-tracker` |
| Android package | `com.lalala0095.vibetracker` |
| EAS account | `lalala0095` |

**Config that ships inside the APK** (`EXPO_PUBLIC_*` is embedded in the binary — this is fine,
both values are already public in the web bundle):

- `EXPO_PUBLIC_API_URL` — the Cloud Run URL
- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` — the existing `GOOGLE_CLIENT_ID`

`SECRET_KEY`, the service account, and everything in `back/.env.deploy` **never touch mobile**.
Nothing from `.env*` is read, printed, or committed at any point in this project.

Also: upgrade `eas-cli` 21.0.1 → 21.8.0 before the first build.

---

## 10. Rules inherited from the web app

These are not restatable-with-variation. They are the same rules, on a smaller screen.

- **No locking.** Timer-derived values are defaults, never constraints. Nothing on this phone gets
  `editable={false}` on hours, rates, dates or amounts — not on a running tracker, not on a time
  entry already pulled into an invoice. Warn visually; never block.
- **"Sessions" vs "Time Entries."** The `sessions` collection is **Time Entries** and is labelled
  that way. The UI word "Sessions" means `goals`, which v1 does not ship. Nothing in this app may
  say "Sessions".
- **Never send `"null"` to a currency field.** v1 sends no currency at all, which keeps this free.
- **The server owns derived values.** `effective_hours`, `duration_minutes`, every money field —
  displayed as returned, recomputed never.

---

## 11. Risks — and how each one actually turned out

Updated after the build. Kept rather than deleted: what a risk turned into is more useful next time
than what it was feared to be.

| Risk | Outcome |
|---|---|
| GCP Android OAuth client + SHA-1 (§5) | **Still open — the one blocking item.** Everything else shipped. |
| NativeWind v4 ↔ SDK 57 / New Arch | **Moot.** `newArchEnabled` no longer exists in SDK 57's `ExpoConfig` — the New Architecture is the only one left. NativeWind 4.2.6 bundles under it; the compiled style registry was read out of the bundle to prove classes become real styles, not merely that the transform did not crash. |
| No local Java / Android SDK | **Never mattered.** EAS generated the keystore in the cloud; `keytool` was not needed. |
| EAS queue times | As expected. Wall-clock only. |
| 7-day expiry, no refresh | Handled better than planned: a lapsed session triggers one silent re-sign-in *and the failed request is replayed*, with concurrent failures sharing a single recovery. |
| Unpaginated `GET /tasks` / `GET /sessions` | Unchanged and unfixed. The entries screen uses a `ScrollView` for the same reason; that is the file to revisit if a `limit` param ever lands. |
| Google Play | N/A. Internal-distribution APK only. |

### Two things that bit, which this plan did not predict

1. **eas-cli cannot read an `app.config.ts`.** Its own bundled loader throws
   `Cannot read properties of undefined (reading 'CommonJS')`, which breaks `eas init` *and*
   `eas build`. Expo's own loader reads the TS form fine, so it is a CLI limitation. The project's
   own TypeScript version is irrelevant — downgrading 6.0.3 → 5.9 changed nothing, because the CLI
   uses its own copy. **Fix: `app.config.js` with a JSDoc `@type` annotation**, which keeps editor
   type-checking. Do not convert it back.
2. **`eas init` will not write into a dynamic config.** It prints the project id and stops, so
   `extra.eas.projectId` is set by hand. Expected behaviour for any `app.config.js`/`.ts`.

### A bug this plan's own library shipped with

`parseSgt('2026-08-14')` built `'2026-08-14+08:00'` — which parses as nothing — so a bare
`YYYY-MM-DD` silently returned `null`. That shape is everywhere in this system: `due_date`,
`period_start`/`period_end`, `date_from`/`date_to`. It now means Singapore midnight, with regression
cases covering it. Worth remembering that the date-only form is a *real* shape here, not a
malformed timestamp.

---

## 12. What still needs a human

1. **Create the Android OAuth client** (§5, step 4). `eas credentials -p android` is
   interactive-only, so read the SHA-1 there or from the project's credentials page on expo.dev,
   then register it in the GCP console against package `com.lalala0095.vibetracker`. Until this
   exists the APK installs and runs but cannot sign in.
2. **Install the APK and use it.** Everything above is verified by typecheck, bundle, and unit
   tests; none of that proves a screen renders correctly on a phone. That remains the acceptance
   test, and only you can run it.

---

## 13. Verification actually performed

Not a claim that the app is correct — a record of what was and was not checked, so the gaps are
visible.

| Check | Result |
|---|---|
| `tsc --noEmit`, whole tree, all agents integrated | clean |
| `expo export --platform android` | bundles, ~4 MB Hermes bytecode |
| `sgt.ts` + `hours.ts` unit checks | 66/66 across 5 timezones (SGT, UTC, New York, UTC+14, UTC−11) |
| `toISOString` outside comments | zero |
| `editable={false}` / `readOnly` anywhere | zero; every `disabled` is on a `Button` |
| User-visible "Sessions" | zero |
| Route strings vs. route files | all resolve |
| `types.ts` vs `front/src/types.ts` | md5-identical apart from a header |
| `trackerName.ts`, `taskPaste.ts` vs their originals | md5-identical |

**Not verified:** that anything renders correctly on a device. `.expo/types/` is still not
generated, so `typedRoutes` is not enforcing route strings at compile time — the correspondence was
checked by hand instead.
