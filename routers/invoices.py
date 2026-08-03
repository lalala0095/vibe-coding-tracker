import uuid
from datetime import datetime, timedelta
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from auth import get_current_user
from routers.sessions import compute_effective_hours, invoice_claims
from routers.settings import get_invoice_settings
from services.firestore_service import get_firestore_client
from services.invoice_service import (
    assign_invoice_number,
    build_bill_to,
    build_issued_by,
    compute_money,
)
from services.rate_service import resolve_currency, resolve_rate

router = APIRouter(prefix="/invoices", tags=["invoices"])

SGT = pytz.timezone("Asia/Singapore")

# Firestore caps a batch at 500 operations; stay comfortably under it.
_BATCH_LIMIT = 450

VALID_STATUSES = ("draft", "sent", "paid", "void")

VALID_DISCOUNT_TYPES = ("percent", "amount")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class InvoiceLineInput(BaseModel):
    line_id: Optional[str] = None
    task_id: Optional[str] = None
    task_title: str = ""
    project_id: Optional[str] = None
    project_name: str = ""
    description: str = ""
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    hours: float = 0.0
    rate: float = 0.0
    session_ids: list[str] = []
    # ``amount`` is deliberately absent — the server always recomputes it.


class InvoiceLineResponse(BaseModel):
    line_id: str
    task_id: Optional[str]
    task_title: str
    project_id: Optional[str]
    project_name: str
    description: str
    date_from: Optional[str]
    date_to: Optional[str]
    hours: float
    rate: float
    amount: float
    session_ids: list[str]


class InvoiceCreate(BaseModel):
    client_id: str
    project_ids: list[str] = []
    status: str = "draft"
    issue_date: Optional[str] = None
    due_date: Optional[str] = None
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    currency: Optional[str] = None
    lines: list[InvoiceLineInput] = []
    discount_type: Optional[str] = None
    discount_value: float = 0.0
    tax_label: Optional[str] = None
    tax_percent: Optional[float] = None
    notes: Optional[str] = None
    payment_terms: Optional[str] = None


class InvoiceUpdate(BaseModel):
    status: Optional[str] = None
    issue_date: Optional[str] = None
    due_date: Optional[str] = None
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    currency: Optional[str] = None
    lines: Optional[list[InvoiceLineInput]] = None
    discount_type: Optional[str] = None
    discount_value: Optional[float] = None
    tax_label: Optional[str] = None
    tax_percent: Optional[float] = None
    notes: Optional[str] = None
    payment_terms: Optional[str] = None


class InvoiceStatusUpdate(BaseModel):
    status: str


class InvoiceResponse(BaseModel):
    id: str
    invoice_number: str
    client_id: str
    client_name: str
    project_ids: list[str]
    project_names: list[str]
    status: str
    issue_date: str
    due_date: Optional[str]
    period_start: Optional[str]
    period_end: Optional[str]
    currency: str
    lines: list[InvoiceLineResponse]
    subtotal: float
    discount_type: Optional[str]
    discount_value: float
    discount_amount: float
    tax_label: Optional[str]
    tax_percent: float
    tax_amount: float
    total: float
    notes: Optional[str]
    payment_terms: Optional[str]
    bill_to: str
    issued_by: dict
    datetime_inserted: str
    datetime_updated: str


class InvoicePreviewRequest(BaseModel):
    client_id: str
    project_ids: Optional[list[str]] = None
    period_start: str
    period_end: str
    include_invoiced: bool = False


class InvoicePreviewLine(InvoiceLineResponse):
    """
    A preview line, plus the provenance a stored line does not carry.

    Kept separate from ``InvoiceLineResponse`` so the stored invoice shape is
    unchanged — these two fields describe the build-time moment, not the line.
    """

    claimed_entry_count: int = 0
    claimed_by: list[str] = []


class InvoicePreviewResponse(BaseModel):
    client_id: str
    client_name: str
    currency: str
    period_start: str
    period_end: str
    lines: list[InvoicePreviewLine]
    subtotal: float
    running_entry_count: int
    claimed_entry_count: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_sgt() -> str:
    """Return current datetime as ISO-8601 string in Singapore time (UTC+8)."""
    return datetime.now(tz=SGT).isoformat()


def _today_sgt() -> str:
    """Return today's local (SGT) date as ``YYYY-MM-DD``."""
    return datetime.now(tz=SGT).strftime("%Y-%m-%d")


def _entry_date(start_time: Optional[str]) -> Optional[str]:
    """
    Return the local (SGT) ``YYYY-MM-DD`` date of an ISO-8601 timestamp.

    Every timestamp in this app is already written in SGT, so the date portion
    needs no conversion.  An entry spanning midnight is dated by its start.
    """
    if not start_time or len(start_time) < 10:
        return None
    return start_time[:10]


def _add_days(date_str: str, days: int) -> Optional[str]:
    """Return ``date_str`` shifted by ``days``, or None if it cannot be parsed."""
    try:
        parsed = datetime.strptime(date_str, "%Y-%m-%d")
    except (ValueError, TypeError):
        return None
    return (parsed + timedelta(days=days)).strftime("%Y-%m-%d")


def _value_or(data: dict, key: str, default):
    """
    Return ``data[key]``, falling back to ``default`` when absent **or null**.

    ``data.get(key, default)`` is not enough on its own: a key that is present
    holding null returns None and the default never fires, which then fails
    response validation on a non-nullable field and 500s every read of that
    document.  Distinct from ``or``, which would also swallow a legitimate
    ``0.0``, ``""`` or ``False``.
    """
    value = data.get(key, default)
    return default if value is None else value


def _clear_sentinel(value: str) -> Optional[str]:
    """
    Resolve the ``"null"`` clearing sentinel to None.

    An optional string field is cleared by sending the literal string
    ``"null"``; anything else passes through unchanged.  Create needs this as
    much as update: without it, an omitted field and a deliberately empty one
    are indistinguishable, and a computed default silently overwrites the
    user's explicit choice.
    """
    return None if value.lower() == "null" else value


def _fetch_client(db, client_id: str) -> dict:
    """Fetch a client document. Raises 404 if not found."""
    doc = db.collection("clients").document(client_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Client '{client_id}' not found.",
        )
    return doc.to_dict() or {}


def _fetch_projects(db, project_ids) -> dict:
    """
    Fetch several projects in one round trip.

    Keyed by project id so the line builder can resolve rates without a
    Firestore read per line.  Missing projects are simply absent from the map.
    """
    unique_ids = [pid for pid in dict.fromkeys(project_ids) if pid]
    if not unique_ids:
        return {}

    refs = [db.collection("projects").document(pid) for pid in unique_ids]
    projects: dict = {}
    for snapshot in db.get_all(refs):
        if snapshot.exists:
            projects[snapshot.id] = snapshot.to_dict() or {}
    return projects


def _current_session_claims(db, session_ids) -> dict:
    """
    Return ``{session_id: (invoice_ids, invoice_numbers)}`` for live sessions.

    Serves two purposes in one bulk read.  Presence in the map means the
    document exists — a batched update against a deleted document fails the
    whole batch, so a session deleted after invoicing is filtered out rather
    than being allowed to break the write.  The value is every invoice
    currently claiming the entry, which is what lets a clear remove only this
    invoice's claim and leave the others standing.
    """
    unique_ids = [sid for sid in dict.fromkeys(session_ids) if sid]
    if not unique_ids:
        return {}

    refs = [db.collection("sessions").document(sid) for sid in unique_ids]
    claims: dict = {}
    for snapshot in db.get_all(refs):
        if snapshot.exists:
            claims[snapshot.id] = invoice_claims(snapshot.to_dict() or {})
    return claims


def _claim_payload(ids, numbers) -> dict:
    """
    Build the session fields for a claim list.

    The scalar pair is derived from the tail of the list — the most recent
    claimant — so display keeps working while the list stays authoritative.
    """
    return {
        "invoice_ids": ids,
        "invoice_numbers": numbers,
        "invoice_id": ids[-1] if ids else None,
        "invoice_number": (numbers[-1] or None) if numbers else None,
    }


def _sync_session_links(
    db,
    invoice_id: str,
    invoice_number: Optional[str],
    set_ids,
    clear_ids,
) -> None:
    """
    Reconcile ``invoice_id``/``invoice_number`` back-links on time entries.

    Written in batches rather than one update per session.  These fields are
    informational only — they mark an entry as invoiced for display and never
    make it harder to edit or re-use.

    An entry can legitimately sit on several invoices at once — a corrected
    re-issue bills the same hours again — so the claim is a list.  Adding
    appends this invoice; removing takes out only this invoice's claim and
    leaves every other one standing.  That is what stops the *correct* action of
    removing a duplicated entry from one invoice from also unlinking it from
    the other, which would leave it reading as never invoiced.

    Args:
        db: Firestore client.
        invoice_id: The invoice being reconciled.  Added for ``set_ids`` and
            removed for ``clear_ids``, so it is always the real id — including
            on delete, where nothing is added.
        invoice_number: Denormalised number stored alongside the id.
        set_ids: Session ids to claim for this invoice.
        clear_ids: Session ids to release this invoice's claim on.
    """
    set_ids = [sid for sid in dict.fromkeys(set_ids) if sid]
    clear_ids = [sid for sid in dict.fromkeys(clear_ids) if sid and sid not in set_ids]

    # One bulk read serves both the existence filter and the current claims.
    claims = _current_session_claims(db, set_ids + clear_ids)
    operations = []

    for sid in set_ids:
        if sid not in claims:
            continue
        ids, numbers = (list(part) for part in claims[sid])
        if invoice_id in ids:
            numbers[ids.index(invoice_id)] = invoice_number or ""
        else:
            ids.append(invoice_id)
            numbers.append(invoice_number or "")
        operations.append((sid, _claim_payload(ids, numbers)))

    for sid in clear_ids:
        if sid not in claims:
            continue
        ids, numbers = (list(part) for part in claims[sid])
        if invoice_id not in ids:
            continue  # Another invoice's claim — not ours to release.
        index = ids.index(invoice_id)
        del ids[index]
        del numbers[index]
        operations.append((sid, _claim_payload(ids, numbers)))
    if not operations:
        return

    for start in range(0, len(operations), _BATCH_LIMIT):
        batch = db.batch()
        for session_id, payload in operations[start : start + _BATCH_LIMIT]:
            batch.update(db.collection("sessions").document(session_id), payload)
        batch.commit()


def _line_session_ids(lines) -> list:
    """Flatten every ``session_ids`` entry across a list of line dicts."""
    return [sid for line in lines for sid in (line.get("session_ids") or [])]


def _build_lines(line_inputs) -> list:
    """
    Normalise incoming lines into stored line dicts.

    Assigns a ``line_id`` where absent and defaults ``description`` to the task
    title.  ``amount`` is left to the money math, which always recomputes it.
    """
    lines = []
    for line in line_inputs:
        lines.append(
            {
                "line_id": line.line_id or str(uuid.uuid4()),
                "task_id": line.task_id,
                "task_title": line.task_title,
                "project_id": line.project_id,
                "project_name": line.project_name,
                "description": line.description or line.task_title,
                "date_from": line.date_from,
                "date_to": line.date_to,
                "hours": line.hours,
                "rate": line.rate,
                "session_ids": list(line.session_ids or []),
            }
        )
    return lines


def _derive_projects(lines, fallback_ids, fallback_names=None) -> tuple:
    """
    Derive the denormalised project id/name lists from the invoice lines.

    Falls back to the ids supplied on the request when no line carries a
    project, pairing them with ``fallback_names`` where the caller knows them so
    the names are not blanked out.  Informational only — the authoritative
    project reference lives on each line.
    """
    ids: list = []
    names: list = []
    for line in lines:
        project_id = line.get("project_id")
        if project_id and project_id not in ids:
            ids.append(project_id)
            names.append(line.get("project_name") or "")
    if ids:
        return ids, names

    fallback = [pid for pid in dict.fromkeys(fallback_ids or []) if pid]
    names_by_id = dict(zip(fallback_ids or [], fallback_names or []))
    return fallback, [names_by_id.get(pid) or "" for pid in fallback]


def _doc_to_line(data: dict) -> InvoiceLineResponse:
    return InvoiceLineResponse(
        line_id=_value_or(data, "line_id", ""),
        task_id=data.get("task_id"),
        task_title=_value_or(data, "task_title", ""),
        project_id=data.get("project_id"),
        project_name=_value_or(data, "project_name", ""),
        description=_value_or(data, "description", ""),
        date_from=data.get("date_from"),
        date_to=data.get("date_to"),
        hours=_value_or(data, "hours", 0.0),
        rate=_value_or(data, "rate", 0.0),
        amount=_value_or(data, "amount", 0.0),
        session_ids=_value_or(data, "session_ids", []),
    )


def _doc_to_preview_line(data: dict) -> InvoicePreviewLine:
    """
    Build a preview line, carrying the already-claimed provenance.

    ``claimed_by`` names the invoices that already reference this line's time
    entries, so the builder can warn which invoice the hours are also on.
    """
    base = _doc_to_line(data)
    return InvoicePreviewLine(
        **base.model_dump(),
        claimed_entry_count=data.get("claimed_entry_count", 0),
        claimed_by=data.get("claimed_by", []) or [],
    )


def _doc_to_invoice(doc) -> InvoiceResponse:
    data = doc.to_dict()
    return InvoiceResponse(
        id=doc.id,
        invoice_number=_value_or(data, "invoice_number", ""),
        client_id=_value_or(data, "client_id", ""),
        client_name=_value_or(data, "client_name", ""),
        project_ids=_value_or(data, "project_ids", []),
        project_names=_value_or(data, "project_names", []),
        status=_value_or(data, "status", "draft"),
        issue_date=_value_or(data, "issue_date", ""),
        due_date=data.get("due_date"),
        period_start=data.get("period_start"),
        period_end=data.get("period_end"),
        currency=_value_or(data, "currency", "SGD"),
        lines=[_doc_to_line(line) for line in _value_or(data, "lines", [])],
        subtotal=_value_or(data, "subtotal", 0.0),
        discount_type=data.get("discount_type"),
        discount_value=_value_or(data, "discount_value", 0.0),
        discount_amount=_value_or(data, "discount_amount", 0.0),
        tax_label=data.get("tax_label"),
        tax_percent=_value_or(data, "tax_percent", 0.0),
        tax_amount=_value_or(data, "tax_amount", 0.0),
        total=_value_or(data, "total", 0.0),
        notes=data.get("notes"),
        payment_terms=data.get("payment_terms"),
        bill_to=_value_or(data, "bill_to", ""),
        issued_by=_value_or(data, "issued_by", {}),
        datetime_inserted=_value_or(data, "datetime_inserted", ""),
        datetime_updated=_value_or(data, "datetime_updated", ""),
    )


def _fetch_invoice_ref(db, invoice_id: str):
    """Return an invoice doc ref and its snapshot. Raises 404 if not found."""
    doc_ref = db.collection("invoices").document(invoice_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Invoice '{invoice_id}' not found.",
        )
    return doc_ref, doc


def _validate_status(value: str) -> str:
    """
    Check a status value against the known set.

    This validates the *value*, not the transition — any status may follow any
    other, and ``void`` is not a lock.
    """
    if value not in VALID_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Status must be one of: {', '.join(VALID_STATUSES)}.",
        )
    return value


def _validate_discount_type(value: Optional[str]) -> Optional[str]:
    """
    Check a discount type against the known set.

    None means no discount and is always allowed.  Anything else must be a type
    the money math understands, so junk cannot reach storage and later read back
    as a discount nobody applied.
    """
    if value is not None and value not in VALID_DISCOUNT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Discount type must be one of: {', '.join(VALID_DISCOUNT_TYPES)}.",
        )
    return value


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[InvoiceResponse])
async def list_invoices(
    _user: Annotated[dict, Depends(get_current_user)],
    client_id: Optional[str] = None,
    # Aliased because the local name ``status`` is taken by fastapi.status.
    status_filter: Optional[str] = Query(None, alias="status"),
) -> list[InvoiceResponse]:
    """
    Return invoices sorted by issue_date descending.

    - ``client_id`` – filter invoices for a specific client.
    - ``status``    – filter by ``draft``, ``sent``, ``paid``, or ``void``.
    """
    db = get_firestore_client()
    query = db.collection("invoices")

    # Apply a single equality filter in Firestore and sort in Python, so no
    # composite index is needed.
    if client_id is not None:
        docs = list(query.where("client_id", "==", client_id).stream())
    else:
        docs = list(query.stream())

    if status_filter is not None:
        docs = [doc for doc in docs if (doc.to_dict() or {}).get("status") == status_filter]

    docs.sort(key=lambda d: (d.to_dict() or {}).get("issue_date", ""), reverse=True)
    return [_doc_to_invoice(doc) for doc in docs]


@router.get("/{invoice_id}", response_model=InvoiceResponse)
async def get_invoice(
    invoice_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoiceResponse:
    """Return a single invoice by its Firestore document ID."""
    db = get_firestore_client()
    _, doc = _fetch_invoice_ref(db, invoice_id)
    return _doc_to_invoice(doc)


@router.post("/preview", response_model=InvoicePreviewResponse)
async def preview_invoice(
    payload: InvoicePreviewRequest,
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoicePreviewResponse:
    """
    Build draft invoice lines from time entries without persisting anything.

    Billable entries in the period are grouped by ``(task_id, project_id)`` — a
    task worked under two projects yields two lines — with ``date_from`` and
    ``date_to`` spanning the contributing entries, ``hours`` summed from each
    entry's effective hours, and the rate resolved from project then client then
    settings.

    - ``project_ids``      – (optional) narrow to specific projects.
    - ``include_invoiced`` – when false, entries already on an invoice are
      skipped.

    Entries still running with no manual hours are excluded and reported via
    ``running_entry_count`` so the caller can warn about them.

    With ``include_invoiced=true``, entries already on another invoice are
    included and reported rather than blocked — re-issuing corrected hours is
    legitimate.  ``claimed_entry_count`` totals them, and each line carries its
    own count plus ``claimed_by``, the invoice numbers already charging those
    hours.  This matters because claiming an entry does not move it: the earlier
    invoice keeps listing it in ``lines`` and keeps billing it, while the entry's
    back-link reports only the most recent claimant.
    """
    db = get_firestore_client()
    settings_data = get_invoice_settings(db)
    client_data = _fetch_client(db, payload.client_id)

    # One equality filter in Firestore, everything else in Python — the same
    # approach sessions.py uses to stay off composite indexes.
    docs = list(
        db.collection("sessions").where("client_id", "==", payload.client_id).stream()
    )

    project_filter = set(payload.project_ids or [])
    groups: dict = {}
    running_entry_count = 0

    for doc in docs:
        data = doc.to_dict() or {}

        if not data.get("billable", True):
            continue

        if project_filter and data.get("project_id") not in project_filter:
            continue

        entry_date = _entry_date(data.get("start_time"))
        if entry_date is None:
            continue
        if entry_date < payload.period_start or entry_date > payload.period_end:
            continue

        claim_ids, claim_numbers = invoice_claims(data)
        if not payload.include_invoiced and claim_ids:
            continue

        hours = data.get("hours")
        if not data.get("end_time") and hours is None:
            running_entry_count += 1
            continue

        effective_hours = compute_effective_hours(
            hours, data.get("start_time", ""), data.get("end_time")
        )

        key = (data.get("task_id"), data.get("project_id"))
        group = groups.get(key)
        if group is None:
            group = {
                "task_id": data.get("task_id"),
                "task_title": data.get("task_title", ""),
                "project_id": data.get("project_id"),
                "project_name": data.get("project_name", ""),
                "date_from": entry_date,
                "date_to": entry_date,
                "hours": 0.0,
                "session_ids": [],
                "claimed_entry_count": 0,
                "claimed_by": [],
            }
            groups[key] = group

        group["date_from"] = min(group["date_from"], entry_date)
        group["date_to"] = max(group["date_to"], entry_date)
        group["hours"] += effective_hours
        group["session_ids"].append(doc.id)

        # An entry already on another invoice is still billable here — a
        # corrected re-issue is legitimate — but the caller must be told, since
        # the earlier invoice keeps listing it and keeps charging for it.
        if claim_ids:
            group["claimed_entry_count"] += 1
            for claim_id, claim_number in zip(claim_ids, claim_numbers):
                label = claim_number or claim_id
                if label not in group["claimed_by"]:
                    group["claimed_by"].append(label)

    projects = _fetch_projects(db, [key[1] for key in groups])
    settings_default_rate = settings_data.get("default_rate")

    lines = []
    for group in groups.values():
        project_data = projects.get(group["project_id"])
        lines.append(
            {
                "line_id": str(uuid.uuid4()),
                "task_id": group["task_id"],
                "task_title": group["task_title"],
                "project_id": group["project_id"],
                "project_name": group["project_name"],
                "description": group["task_title"],
                "date_from": group["date_from"],
                "date_to": group["date_to"],
                "hours": group["hours"],
                "rate": resolve_rate(
                    None, project_data, client_data, settings_default_rate
                ),
                "session_ids": group["session_ids"],
                "claimed_entry_count": group["claimed_entry_count"],
                "claimed_by": group["claimed_by"],
            }
        )

    lines.sort(key=lambda line: (line["date_from"] or "", line["task_title"] or ""))
    money = compute_money(lines, None, 0.0, 0.0)

    return InvoicePreviewResponse(
        client_id=payload.client_id,
        client_name=client_data.get("name", ""),
        currency=resolve_currency(
            client_data, settings_data.get("default_currency", "SGD")
        ),
        period_start=payload.period_start,
        period_end=payload.period_end,
        lines=[_doc_to_preview_line(line) for line in money["lines"]],
        subtotal=money["subtotal"],
        running_entry_count=running_entry_count,
        claimed_entry_count=sum(line["claimed_entry_count"] for line in money["lines"]),
    )


@router.post("", response_model=InvoiceResponse, status_code=status.HTTP_201_CREATED)
async def create_invoice(
    payload: InvoiceCreate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoiceResponse:
    """
    Create an invoice from the lines as edited by the user.

    The server recomputes every monetary figure, assigns the next number inside
    a transaction, and snapshots ``bill_to`` and ``issued_by`` so later edits to
    the client or to settings never rewrite this invoice.  Referenced time
    entries are flagged with the invoice id and number.

    Unspecified meta falls back to the invoice settings: currency from the
    client, tax label and percent, payment terms, and a due date derived from
    ``default_due_days``.

    - Pass ``due_date="null"`` to create an invoice with no due date — billed on
      receipt — rather than taking the ``default_due_days`` fallback.
    - ``tax_label``, ``payment_terms``, ``notes``, and ``discount_type`` take
      the same ``"null"`` sentinel, so an explicitly empty value is never
      replaced by a default.
    """
    db = get_firestore_client()
    settings_data = get_invoice_settings(db)
    client_data = _fetch_client(db, payload.client_id)

    _validate_status(payload.status)

    issue_date = payload.issue_date or _today_sgt()

    # Omitting a field takes the settings default; sending "null" is the user
    # deliberately choosing none, and must not be overwritten by that default.
    if payload.due_date is None:
        due_date = _add_days(issue_date, settings_data.get("default_due_days", 14))
    else:
        due_date = _clear_sentinel(payload.due_date)

    if payload.tax_label is None:
        tax_label = settings_data.get("default_tax_label", "GST")
    else:
        tax_label = _clear_sentinel(payload.tax_label)

    if payload.payment_terms is None:
        payment_terms = settings_data.get("default_payment_terms", "Net 14")
    else:
        payment_terms = _clear_sentinel(payload.payment_terms)

    notes = None if payload.notes is None else _clear_sentinel(payload.notes)
    discount_type = _validate_discount_type(
        None
        if payload.discount_type is None
        else _clear_sentinel(payload.discount_type)
    )

    tax_percent = payload.tax_percent
    if tax_percent is None:
        tax_percent = _value_or(settings_data, "default_tax_percent", 0.0)

    lines = _build_lines(payload.lines)
    money = compute_money(lines, discount_type, payload.discount_value, tax_percent)
    project_ids, project_names = _derive_projects(money["lines"], payload.project_ids)
    if project_ids and not any(project_names):
        # Fallback path: the ids came from the request, so resolve their names in
        # one bulk read rather than storing a list of blanks.
        projects_by_id = _fetch_projects(db, project_ids)
        project_names = [
            (projects_by_id.get(pid) or {}).get("name", "") for pid in project_ids
        ]

    invoice_number = assign_invoice_number(db, settings_data)
    now = _now_sgt()

    doc_data = {
        "invoice_number": invoice_number,
        "client_id": payload.client_id,
        "client_name": client_data.get("name", ""),
        "project_ids": project_ids,
        "project_names": project_names,
        "status": payload.status,
        "issue_date": issue_date,
        "due_date": due_date,
        "period_start": payload.period_start,
        "period_end": payload.period_end,
        "currency": payload.currency
        or resolve_currency(client_data, settings_data.get("default_currency", "SGD")),
        "lines": money["lines"],
        "subtotal": money["subtotal"],
        "discount_type": discount_type,
        "discount_value": payload.discount_value,
        "discount_amount": money["discount_amount"],
        "tax_label": tax_label,
        "tax_percent": tax_percent,
        "tax_amount": money["tax_amount"],
        "total": money["total"],
        "notes": notes,
        "payment_terms": payment_terms,
        "bill_to": build_bill_to(client_data),
        "issued_by": build_issued_by(settings_data),
        "datetime_inserted": now,
        "datetime_updated": now,
    }

    _, doc_ref = db.collection("invoices").add(doc_data)

    _sync_session_links(
        db,
        doc_ref.id,
        invoice_number,
        _line_session_ids(money["lines"]),
        [],
    )

    return _doc_to_invoice(doc_ref.get())


@router.put("/{invoice_id}", response_model=InvoiceResponse)
async def update_invoice(
    invoice_id: str,
    payload: InvoiceUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoiceResponse:
    """
    Update an invoice's lines and meta.

    All monetary figures are recomputed from the submitted lines, and session
    back-links are reconciled — entries dropped from the invoice are unlinked
    unless another invoice has since claimed them, and newly referenced entries
    are linked.  A sent or paid invoice is editable like any other; status never
    blocks a change.

    - Pass ``"null"`` for ``due_date``, ``discount_type``, ``tax_label``,
      ``notes``, or ``payment_terms`` to clear that field — the same five that
      take the sentinel on create.  ``currency`` does not: it is non-nullable
      and has no "no currency" meaning.
    - Only fields present in the payload are updated.
    """
    db = get_firestore_client()
    doc_ref, doc = _fetch_invoice_ref(db, invoice_id)
    existing = doc.to_dict() or {}

    updates: dict = {}

    if payload.status is not None:
        updates["status"] = _validate_status(payload.status)

    if payload.issue_date is not None:
        updates["issue_date"] = payload.issue_date

    if payload.due_date is not None:
        updates["due_date"] = _clear_sentinel(payload.due_date)

    if payload.period_start is not None:
        updates["period_start"] = payload.period_start

    if payload.period_end is not None:
        updates["period_end"] = payload.period_end

    if payload.currency is not None:
        updates["currency"] = payload.currency

    if payload.tax_label is not None:
        updates["tax_label"] = _clear_sentinel(payload.tax_label)

    if payload.notes is not None:
        updates["notes"] = _clear_sentinel(payload.notes)

    if payload.payment_terms is not None:
        updates["payment_terms"] = _clear_sentinel(payload.payment_terms)

    if payload.discount_type is not None:
        updates["discount_type"] = _validate_discount_type(
            _clear_sentinel(payload.discount_type)
        )

    # NOT the model_fields_set convention: these two are non-nullable on the
    # response, so there is no "cleared" state to express.  An explicit null is
    # treated as "not supplied" and never written — writing it would poison the
    # document and 500 every subsequent read of the whole collection.
    if payload.discount_value is not None:
        updates["discount_value"] = payload.discount_value
    if payload.tax_percent is not None:
        updates["tax_percent"] = payload.tax_percent

    # Money always gets recomputed, using whichever of lines/discount/tax the
    # payload changed and the stored values for the rest.
    lines = (
        _build_lines(payload.lines)
        if payload.lines is not None
        else existing.get("lines", []) or []
    )
    discount_type = updates.get("discount_type", existing.get("discount_type"))
    # _value_or, not .get: a document damaged before the guard was fixed holds
    # a present null here, and a PUT must repair it rather than trip over it.
    discount_value = updates.get(
        "discount_value", _value_or(existing, "discount_value", 0.0)
    )
    tax_percent = updates.get("tax_percent", _value_or(existing, "tax_percent", 0.0))

    money = compute_money(lines, discount_type, discount_value, tax_percent)
    project_ids, project_names = _derive_projects(
        money["lines"], existing.get("project_ids"), existing.get("project_names")
    )

    updates["lines"] = money["lines"]
    updates["subtotal"] = money["subtotal"]
    # Written back even when the payload did not touch them, so a document
    # holding a null from before the guard was fixed is repaired by any edit
    # rather than staying poisoned until someone happens to set the field.
    updates["discount_value"] = discount_value
    updates["tax_percent"] = tax_percent
    updates["discount_amount"] = money["discount_amount"]
    updates["tax_amount"] = money["tax_amount"]
    updates["total"] = money["total"]
    updates["project_ids"] = project_ids
    updates["project_names"] = project_names
    updates["datetime_updated"] = _now_sgt()

    doc_ref.update(updates)

    new_session_ids = _line_session_ids(money["lines"])
    old_session_ids = _line_session_ids(existing.get("lines", []) or [])
    _sync_session_links(
        db,
        invoice_id,
        existing.get("invoice_number", ""),
        new_session_ids,
        [sid for sid in old_session_ids if sid not in set(new_session_ids)],
    )

    return _doc_to_invoice(doc_ref.get())


@router.patch("/{invoice_id}/status", response_model=InvoiceResponse)
async def update_invoice_status(
    invoice_id: str,
    payload: InvoiceStatusUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoiceResponse:
    """
    Set an invoice's status.

    Any status may follow any other — marking an invoice paid and then back to
    draft is allowed, and ``void`` is not a lock.
    """
    db = get_firestore_client()
    doc_ref, _ = _fetch_invoice_ref(db, invoice_id)

    doc_ref.update(
        {
            "status": _validate_status(payload.status),
            "datetime_updated": _now_sgt(),
        }
    )
    return _doc_to_invoice(doc_ref.get())


@router.delete("/{invoice_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_invoice(
    invoice_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> None:
    """
    Delete an invoice and clear the back-links on its time entries.

    Only entries still linked to this invoice are cleared — any that have since
    been pulled onto another invoice keep that newer link.
    """
    db = get_firestore_client()
    doc_ref, doc = _fetch_invoice_ref(db, invoice_id)
    existing = doc.to_dict() or {}

    _sync_session_links(
        db,
        invoice_id,
        existing.get("invoice_number", ""),
        [],
        _line_session_ids(existing.get("lines", []) or []),
    )
    doc_ref.delete()
