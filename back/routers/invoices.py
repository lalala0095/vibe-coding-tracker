import math
import re
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from auth import get_current_user
from routers.sessions import compute_effective_hours, invoice_claims
from routers.settings import get_invoice_settings
from routers.trackers import _tracker_hours
from services.firestore_service import get_firestore_client
from services.invoice_service import (
    assign_invoice_number,
    build_bill_to,
    build_issued_by,
    compute_money,
    compute_payments,
    total_hours_from_lines,
)
from services.rate_service import resolve_currency, resolve_rate

router = APIRouter(prefix="/invoices", tags=["invoices"])

SGT = pytz.timezone("Asia/Singapore")

# Firestore caps a batch at 500 operations; stay comfortably under it.
_BATCH_LIMIT = 450

VALID_STATUSES = ("draft", "sent", "paid", "void")

VALID_DISCOUNT_TYPES = ("percent", "amount")

# A date the money math and the printed document can both rely on.  strptime
# alone is too lenient — it happily accepts "2026-8-1" — so the shape is checked
# first and the calendar second.
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

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
    # A line billing a whole tracker rather than a task's time entries.  Both
    # are snapshots like ``task_title`` — the tracker is never re-read to
    # rebuild them, so renaming or deleting it never rewrites a past invoice.
    tracker_id: Optional[str] = None
    sub_items: list[str] = []
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
    tracker_id: Optional[str] = None
    sub_items: list[str] = []


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
    # Print-only visibility switches.  They hide a block on the printed
    # document; the underlying value is still stored and still editable.
    show_due_date: Optional[bool] = None
    show_payment_terms: Optional[bool] = None


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
    show_due_date: Optional[bool] = None
    show_payment_terms: Optional[bool] = None


class InvoiceStatusUpdate(BaseModel):
    status: str


class PaymentCreate(BaseModel):
    paid_on: str
    amount_paid: float
    amount_received: float
    # Omit to take the payout currency from settings, then the invoice's own.
    received_currency: Optional[str] = None
    notes: Optional[str] = None
    # ``currency`` is deliberately absent — it is snapshotted from the invoice.
    # ``rate`` too: the server always recomputes it.


class PaymentUpdate(BaseModel):
    paid_on: Optional[str] = None
    amount_paid: Optional[float] = None
    amount_received: Optional[float] = None
    received_currency: Optional[str] = None
    notes: Optional[str] = None


class PaymentResponse(BaseModel):
    payment_id: str
    paid_on: str
    amount_paid: float
    currency: str
    amount_received: float
    received_currency: str
    rate: Optional[float]
    notes: Optional[str]
    datetime_inserted: str
    datetime_updated: str


class ReceivedTotal(BaseModel):
    """What arrived, totalled per currency — never summed across them."""

    currency: str
    amount: float


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
    total_hours: float
    discount_type: Optional[str]
    discount_value: float
    discount_amount: float
    tax_label: Optional[str]
    tax_percent: float
    tax_amount: float
    total: float
    payments: list[PaymentResponse]
    amount_paid: float
    received_totals: list[ReceivedTotal]
    outstanding: float
    effective_rate: Optional[float]
    notes: Optional[str]
    payment_terms: Optional[str]
    show_due_date: bool
    show_payment_terms: bool
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
    include_trackers: bool = True
    # Not a filter — it narrows nothing.  It names the invoice whose own claims
    # are to be ignored, so re-previewing an existing invoice sees the entries
    # and trackers *it* already claims as unclaimed.  Without it, regenerating
    # an invoice's lines would drop every one of them as "already invoiced" and
    # come back empty.  Claims held by any other invoice are unaffected.
    for_invoice_id: Optional[str] = None


class InvoicePreviewLine(InvoiceLineResponse):
    """
    A preview line, plus the provenance a stored line does not carry.

    Kept separate from ``InvoiceLineResponse`` so the stored invoice shape is
    unchanged — these fields describe the build-time moment, not the line.

    ``source`` says where the line came from.  A tracker line covers the same
    ground as the time entries billed off it, so ``include_by_default`` tells
    the builder which lines to tick and ``duplicate_reason`` says, in words the
    user can act on, why the rest are left unticked.  Neither is a block: every
    line stays selectable.
    """

    claimed_entry_count: int = 0
    claimed_by: list[str] = []
    source: str = "time_entry"
    include_by_default: bool = True
    duplicate_reason: Optional[str] = None


class InvoicePreviewResponse(BaseModel):
    client_id: str
    client_name: str
    currency: str
    period_start: str
    period_end: str
    lines: list[InvoicePreviewLine]
    subtotal: float
    total_hours: float
    running_entry_count: int
    claimed_entry_count: int
    tracker_line_count: int = 0
    duplicate_tracker_count: int = 0


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


def _tracker_candidates(
    db,
    client_id: str,
    project_filter: set,
    period_start: str,
    period_end: str,
) -> list:
    """
    Return the in-period trackers billable to this client, with their tasks.

    A tracker document carries no ``client_id`` or ``project_id`` of its own —
    only a list of TaskRefs — so who it bills to has to come from its tasks.
    Every task across every in-period tracker is read in one bulk ``get_all``,
    then each tracker keeps only the tasks matching the client, and the project
    filter when one is set.  A tracker with no surviving task is dropped: it
    belongs to somebody else's invoice.

    The period filter is applied in Python on the same inclusive string
    comparison the time entries use, so no composite index is needed.

    Returns:
        ``[(tracker_doc, tracker_data, [task_data, ...]), ...]`` with the tasks
        in the order the tracker lists them.
    """
    docs = list(
        db.collection("trackers")
        .order_by("start_time", direction="DESCENDING")
        .stream()
    )

    candidates = []
    for doc in docs:
        data = doc.to_dict() or {}

        tracker_date = _entry_date(data.get("start_time"))
        if tracker_date is None:
            continue
        if tracker_date < period_start or tracker_date > period_end:
            continue

        task_refs = data.get("tasks") or []
        if not task_refs:
            continue

        candidates.append((doc, data, task_refs))

    ordered_ids = [
        ref.get("task_id", "") for _, _, task_refs in candidates for ref in task_refs
    ]
    unique_ids = [tid for tid in dict.fromkeys(ordered_ids) if tid]
    tasks: dict = {}
    if unique_ids:
        refs = [db.collection("tasks").document(tid) for tid in unique_ids]
        for snapshot in db.get_all(refs):
            if snapshot.exists:
                tasks[snapshot.id] = snapshot.to_dict() or {}

    resolved = []
    for doc, data, task_refs in candidates:
        # Read the tasks fresh rather than trusting the TaskRefs on the tracker:
        # a TaskRef carries no client_id or project_id, and a task deleted since
        # is simply absent from the map.
        matched = [
            tasks[ref.get("task_id", "")]
            for ref in task_refs
            if ref.get("task_id", "") in tasks
        ]
        matched = [
            task
            for task in matched
            if task.get("client_id") == client_id
            and (not project_filter or task.get("project_id") in project_filter)
        ]
        if matched:
            resolved.append((doc, data, matched))
    return resolved


def _single_project_id(task_datas) -> Optional[str]:
    """
    Return the one project every task shares, or None when they differ.

    A tracker spanning two projects has no single project to bill under, so its
    line carries none and the rate falls back to the client's.
    """
    project_ids = {task.get("project_id") for task in task_datas}
    if len(project_ids) == 1:
        return next(iter(project_ids)) or None
    return None


def _visible_claims(claims: tuple, exclude_invoice_id: Optional[str]) -> tuple:
    """
    Drop one invoice's own claim from an ``invoice_claims`` result.

    Not a filter over documents — nothing is skipped or narrowed here.  When an
    invoice re-previews its own period, the entries and trackers it already
    bills are claimed *by it*, and treating that as "already invoiced" would
    empty the very invoice being rebuilt.  Excluding its id makes its own claim
    invisible so those lines come back exactly as they would have the first
    time, while a claim held by any other invoice is still reported and still
    honoured by ``include_invoiced``.

    The two lists are parallel, so both are rebuilt together — dropping from one
    alone would shift every following number onto the wrong invoice.

    Args:
        claims: The ``(invoice_ids, invoice_numbers)`` pair from
            ``invoice_claims``.
        exclude_invoice_id: The invoice to make invisible, or None to pass the
            claims through untouched.
    """
    claim_ids, claim_numbers = claims
    if not exclude_invoice_id:
        return claim_ids, claim_numbers

    # Indexed rather than zipped.  ``invoice_claims`` pads the numbers to match
    # the ids, but zip would silently truncate to the shorter list if that ever
    # stopped being true, dropping a real claim held by another invoice — and a
    # dropped claim reads as never invoiced, which bills the client twice.  A
    # missing number is only a missing label, so it degrades to "".
    kept_ids: list = []
    kept_numbers: list = []
    for index, claim_id in enumerate(claim_ids):
        if claim_id == exclude_invoice_id:
            continue
        kept_ids.append(claim_id)
        kept_numbers.append(
            claim_numbers[index] if index < len(claim_numbers) else ""
        )
    return kept_ids, kept_numbers


def _claim_labels(claim_ids, claim_numbers) -> list:
    """Name each claiming invoice by its number, falling back to its id."""
    labels: list = []
    for claim_id, claim_number in zip(claim_ids, claim_numbers):
        label = claim_number or claim_id
        if label not in labels:
            labels.append(label)
    return labels


def _current_claims(db, collection: str, doc_ids) -> dict:
    """
    Return ``{doc_id: (invoice_ids, invoice_numbers)}`` for live documents.

    Serves two purposes in one bulk read.  Presence in the map means the
    document exists — a batched update against a deleted document fails the
    whole batch, so a session or tracker deleted after invoicing is filtered out
    rather than being allowed to break the write.  The value is every invoice
    currently claiming it, which is what lets a clear remove only this invoice's
    claim and leave the others standing.

    Sessions and trackers carry the identical claim shape, so one reader serves
    both collections.
    """
    unique_ids = [did for did in dict.fromkeys(doc_ids) if did]
    if not unique_ids:
        return {}

    refs = [db.collection(collection).document(did) for did in unique_ids]
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


def _sync_claim_links(
    db,
    collection: str,
    invoice_id: str,
    invoice_number: Optional[str],
    set_ids,
    clear_ids,
) -> None:
    """
    Reconcile ``invoice_id``/``invoice_number`` back-links on claimed documents.

    Written in batches rather than one update per document.  These fields are
    informational only — they mark a time entry or a tracker as invoiced for
    display and never make it harder to edit or re-use.

    An entry can legitimately sit on several invoices at once — a corrected
    re-issue bills the same hours again — so the claim is a list.  Adding
    appends this invoice; removing takes out only this invoice's claim and
    leaves every other one standing.  That is what stops the *correct* action of
    removing a duplicated entry from one invoice from also unlinking it from
    the other, which would leave it reading as never invoiced.

    Args:
        db: Firestore client.
        collection: ``"sessions"`` or ``"trackers"`` — both carry the same
            claim fields, so the reconciliation is identical either way.
        invoice_id: The invoice being reconciled.  Added for ``set_ids`` and
            removed for ``clear_ids``, so it is always the real id — including
            on delete, where nothing is added.
        invoice_number: Denormalised number stored alongside the id.
        set_ids: Document ids to claim for this invoice.
        clear_ids: Document ids to release this invoice's claim on.
    """
    set_ids = [did for did in dict.fromkeys(set_ids) if did]
    clear_ids = [did for did in dict.fromkeys(clear_ids) if did and did not in set_ids]

    # One bulk read serves both the existence filter and the current claims.
    claims = _current_claims(db, collection, set_ids + clear_ids)
    operations = []

    for did in set_ids:
        if did not in claims:
            continue
        ids, numbers = (list(part) for part in claims[did])
        if invoice_id in ids:
            numbers[ids.index(invoice_id)] = invoice_number or ""
        else:
            ids.append(invoice_id)
            numbers.append(invoice_number or "")
        operations.append((did, _claim_payload(ids, numbers)))

    for did in clear_ids:
        if did not in claims:
            continue
        ids, numbers = (list(part) for part in claims[did])
        if invoice_id not in ids:
            continue  # Another invoice's claim — not ours to release.
        index = ids.index(invoice_id)
        del ids[index]
        del numbers[index]
        operations.append((did, _claim_payload(ids, numbers)))
    if not operations:
        return

    for start in range(0, len(operations), _BATCH_LIMIT):
        batch = db.batch()
        for doc_id, payload in operations[start : start + _BATCH_LIMIT]:
            batch.update(db.collection(collection).document(doc_id), payload)
        batch.commit()


def _sync_session_links(
    db,
    invoice_id: str,
    invoice_number: Optional[str],
    set_ids,
    clear_ids,
) -> None:
    """Reconcile this invoice's back-links on the time entries it bills."""
    _sync_claim_links(db, "sessions", invoice_id, invoice_number, set_ids, clear_ids)


def _sync_tracker_links(
    db,
    invoice_id: str,
    invoice_number: Optional[str],
    set_ids,
    clear_ids,
) -> None:
    """
    Reconcile this invoice's back-links on the trackers it bills.

    Without it the same tracker could be billed onto a second invoice with
    nothing to warn about it — the preview reads these claims exactly as it
    reads a time entry's.
    """
    _sync_claim_links(db, "trackers", invoice_id, invoice_number, set_ids, clear_ids)


def _line_session_ids(lines) -> list:
    """Flatten every ``session_ids`` entry across a list of line dicts."""
    return [sid for line in lines for sid in (line.get("session_ids") or [])]


def _line_tracker_ids(lines) -> list:
    """Flatten the non-null ``tracker_id`` of each line dict."""
    return [line.get("tracker_id") for line in lines if line.get("tracker_id")]


def _build_lines(line_inputs) -> list:
    """
    Normalise incoming lines into stored line dicts.

    Assigns a ``line_id`` where absent and defaults ``description`` to the task
    title.  ``amount`` is left to the money math, which always recomputes it.

    ``tracker_id`` and ``sub_items`` are copied verbatim, never re-derived from
    the tracker: they are snapshots, so a tracker that later gains, loses or
    renames a task does not rewrite an invoice already sent.
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
                "tracker_id": line.tracker_id,
                "sub_items": [str(item) for item in (line.sub_items or [])],
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
        tracker_id=data.get("tracker_id"),
        sub_items=_value_or(data, "sub_items", []),
    )


def _doc_to_payment(data: dict) -> PaymentResponse:
    """
    Build a payment response from a stored payment dict.

    ``data.get(key, default)`` per field, like ``_doc_to_line``, so a payment
    written before a field existed reads back rather than 500ing the whole
    invoice.
    """
    return PaymentResponse(
        payment_id=data.get("payment_id", ""),
        paid_on=data.get("paid_on", ""),
        amount_paid=data.get("amount_paid", 0.0),
        currency=data.get("currency", ""),
        amount_received=data.get("amount_received", 0.0),
        received_currency=data.get("received_currency", ""),
        rate=data.get("rate"),
        notes=data.get("notes"),
        datetime_inserted=data.get("datetime_inserted", ""),
        datetime_updated=data.get("datetime_updated", ""),
    )


def _doc_to_preview_line(data: dict) -> InvoicePreviewLine:
    """
    Build a preview line, carrying the already-claimed provenance.

    ``claimed_by`` names the invoices that already reference this line's time
    entries, so the builder can warn which invoice the hours are also on.
    ``include_by_default`` and ``duplicate_reason`` are advisory in the same
    way — they steer the initial ticks, never the user's final choice.
    """
    base = _doc_to_line(data)
    return InvoicePreviewLine(
        **base.model_dump(),
        claimed_entry_count=data.get("claimed_entry_count", 0),
        claimed_by=data.get("claimed_by", []) or [],
        source=data.get("source", "time_entry"),
        include_by_default=data.get("include_by_default", True),
        duplicate_reason=data.get("duplicate_reason"),
    )


def _doc_to_invoice(doc) -> InvoiceResponse:
    data = doc.to_dict()
    stored_lines = _value_or(data, "lines", [])
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
        currency=_value_or(data, "currency", "USD"),
        lines=[_doc_to_line(line) for line in stored_lines],
        subtotal=_value_or(data, "subtotal", 0.0),
        # Not defaulted to 0.0.  An invoice written before this field existed
        # would then print a confident, wrong "0.00 h"; re-adding its own stored
        # lines gives the true figure.  That is not re-resolving live data — the
        # lines are part of the invoice's snapshot — so the answer cannot drift.
        # ``_value_or`` is the right helper because it fires only on absent-or-
        # null: an invoice genuinely billing zero hours holds a stored 0.0, which
        # is not None and so is preserved rather than being re-derived.
        total_hours=_value_or(data, "total_hours", total_hours_from_lines(stored_lines)),
        discount_type=data.get("discount_type"),
        discount_value=_value_or(data, "discount_value", 0.0),
        discount_amount=_value_or(data, "discount_amount", 0.0),
        tax_label=data.get("tax_label"),
        tax_percent=_value_or(data, "tax_percent", 0.0),
        tax_amount=_value_or(data, "tax_amount", 0.0),
        total=_value_or(data, "total", 0.0),
        # An invoice stored before payments existed has none of these keys, so
        # every one falls back rather than failing response validation.
        payments=[
            _doc_to_payment(payment) for payment in _value_or(data, "payments", [])
        ],
        amount_paid=_value_or(data, "amount_paid", 0.0),
        received_totals=_value_or(data, "received_totals", []),
        outstanding=_value_or(data, "outstanding", _value_or(data, "total", 0.0)),
        effective_rate=data.get("effective_rate"),
        notes=data.get("notes"),
        payment_terms=data.get("payment_terms"),
        # An invoice created before these existed prints both blocks, which is
        # exactly what it printed before.
        show_due_date=_value_or(data, "show_due_date", True),
        show_payment_terms=_value_or(data, "show_payment_terms", True),
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


def _validate_paid_on(value: str) -> str:
    """
    Check a payment date is a real calendar date written ``YYYY-MM-DD``.

    Two checks, because neither alone is enough: the regex rejects the shapes
    ``strptime`` would quietly accept (``2026-8-1``) and ``strptime`` rejects the
    calendar nonsense the regex would wave through (``2026-13-45``).  A payment
    date is sorted and compared as a string everywhere else in this app, so a
    stray format would silently sort wrong rather than fail loudly.
    """
    if not _ISO_DATE_RE.match(value or ""):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="paid_on must be a date in YYYY-MM-DD format.",
        )
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"paid_on '{value}' is not a real date.",
        )
    return value


def _validate_amount(value: float, field: str) -> float:
    """
    Check an amount is a finite number.

    NaN and infinity are rejected because they poison every sum they touch and
    read back as ``null`` through JSON, which would 500 the invoice afterwards.

    A **negative** amount passes deliberately.  A refund, a chargeback or a
    correction is a legitimate thing to record, and per the no-locking principle
    the server does not police the owner's own figures.  An overpayment passes
    for the same reason — ``outstanding`` simply goes negative.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field} must be a number.",
        )
    if not math.isfinite(number):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field} must be a finite number.",
        )
    return number


def _validate_received_currency(value: str) -> str:
    """
    Normalise a received currency and **reject** the ``"null"`` clearing sentinel.

    Rejected, not ignored.  The sentinel clears optional strings elsewhere in
    this app (``notes`` below still takes it), but a currency has no cleared
    state: it is stamped on a client-facing document, and storing the literal
    text ``"null"`` would print "null 68,400" on an invoice.  Silently ignoring
    it would leave the caller believing a currency it named was applied, so the
    request fails instead — case-insensitively, matching ``_clear_sentinel``.

    **Uppercased, and it must stay that way to match ``_validate_payout_currency``
    in settings.py.**  ``compute_payments`` groups received money by the exact
    currency string, so ``"php"`` and ``"PHP"`` are two different currencies to
    it: one invoice would report two ``received_totals`` rows for what is really
    one currency, and ``effective_rate`` would silently go None, since a rate is
    only quoted when there is exactly one received currency.  The settings
    default already arrives uppercased, so a typed override that did not would
    split against it.

    Deliberately *not* applying settings.py's 2–5 letter shape check.  That field
    is one configured default worth validating once; this one is per-payment data
    the owner types, and the no-locking principle says the server warns about the
    owner's own figures rather than refusing them.  A malformed code here is
    visible on screen and fixable with a PATCH — it corrupts no arithmetic.
    """
    trimmed = (value or "").strip()
    if trimmed.lower() == "null":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "received_currency cannot be cleared — send a currency code, or "
                "omit the field to take the default."
            ),
        )
    return trimmed.upper()


def _resolve_received_currency(
    requested: Optional[str],
    settings_data: dict,
    invoice_currency: str,
) -> str:
    """
    Pick the currency the money arrived in.

    In order: what the caller asked for, the payout currency configured in
    invoice settings, then the invoice's own currency as the last resort — so
    the field is never blank even before a payout currency has been configured.

    ``payout_currency`` is read defensively: settings documents written before
    it existed simply do not carry the key.

    Every branch is uppercased, for the grouping reason spelled out in
    ``_validate_received_currency``.  The settings default already is; the
    invoice's own currency is stored verbatim as the user typed it, so an
    invoice raised in ``"usd"`` would otherwise split against a payment that
    took either of the other two branches.
    """
    if requested is not None:
        chosen = _validate_received_currency(requested)
        if chosen:
            return chosen

    payout = (settings_data.get("payout_currency") or "").strip()
    return (payout or invoice_currency or "").upper()


def _stored_payments(existing: dict) -> list:
    """Return an invoice's stored payments, tolerating an absent or null key."""
    return list(_value_or(existing, "payments", []) or [])


def _payment_figures(payments, total) -> dict:
    """
    Recompute every payment-derived field for storage.

    The one place the derived figures are produced, so create, update, status
    change and the payment endpoints cannot drift apart.  Client-supplied
    ``amount_paid``/``outstanding``/``rate`` are never written — like the money
    totals, they are always recomputed here.
    """
    computed = compute_payments(list(payments or []), total)
    return {
        "payments": computed["payments"],
        "amount_paid": computed["amount_paid"],
        "received_totals": computed["received_totals"],
        "outstanding": computed["outstanding"],
        "effective_rate": computed["effective_rate"],
    }


def _find_payment(payments: list, payment_id: str) -> int:
    """Return the index of a payment on an invoice. Raises 404 if not found."""
    for index, payment in enumerate(payments):
        if payment.get("payment_id") == payment_id:
            return index
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Payment '{payment_id}' not found.",
    )


def _write_payments(doc_ref, payments, total) -> None:
    """Persist a rebuilt payment list along with its derived figures."""
    updates = _payment_figures(payments, total)
    updates["datetime_updated"] = _now_sgt()
    doc_ref.update(updates)


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

    A tracker in the period is also offered as a line of its own, titled after
    the tracker with its task titles as ``sub_items`` and its hours taken from
    its elapsed span.  Such a line claims no sessions — the tracker's time
    entries are billed by their own lines — so the two are alternatives, not
    additions.  When both are present the tracker line comes back unticked
    (``include_by_default=False``) with ``duplicate_reason`` saying why; nothing
    is hidden or blocked, and the user is free to tick it anyway.

    - ``project_ids``      – (optional) narrow to specific projects.
    - ``include_invoiced`` – when false, entries already on an invoice are
      skipped.
    - ``include_trackers`` – when false, no tracker lines are built at all.
    - ``for_invoice_id``   – the invoice being rebuilt, whose own claims are
      ignored so its entries and trackers read as unclaimed.

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
    # Counted off the same stream the groups are built from, so spotting a
    # tracker whose entries are already listed costs no extra Firestore read.
    sessions_by_tracker: dict = {}

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

        claim_ids, claim_numbers = _visible_claims(
            invoice_claims(data), payload.for_invoice_id
        )
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

        entry_tracker_id = data.get("tracker_id")
        if entry_tracker_id:
            sessions_by_tracker[entry_tracker_id] = (
                sessions_by_tracker.get(entry_tracker_id, 0) + 1
            )

        # An entry already on another invoice is still billable here — a
        # corrected re-issue is legitimate — but the caller must be told, since
        # the earlier invoice keeps listing it and keeps charging for it.
        if claim_ids:
            group["claimed_entry_count"] += 1
            for claim_id, claim_number in zip(claim_ids, claim_numbers):
                label = claim_number or claim_id
                if label not in group["claimed_by"]:
                    group["claimed_by"].append(label)

    tracker_candidates = (
        _tracker_candidates(
            db,
            payload.client_id,
            project_filter,
            payload.period_start,
            payload.period_end,
        )
        if payload.include_trackers
        else []
    )

    # One bulk project read serves both kinds of line.
    projects = _fetch_projects(
        db,
        [key[1] for key in groups]
        + [_single_project_id(tasks) for _, _, tasks in tracker_candidates],
    )
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
                "source": "time_entry",
                "include_by_default": True,
                "duplicate_reason": None,
            }
        )

    for doc, data, task_datas in tracker_candidates:
        claim_ids, claim_numbers = _visible_claims(
            invoice_claims(data), payload.for_invoice_id
        )
        if not payload.include_invoiced and claim_ids:
            continue

        project_id = _single_project_id(task_datas)
        project_name = next(
            (
                task.get("project_name", "")
                for task in task_datas
                if project_id and task.get("project_id") == project_id
            ),
            "",
        )

        title = data.get("title", "")
        start_time = data.get("start_time", "")
        end_time = data.get("end_time")
        date_from = _entry_date(start_time) or ""
        hours = _tracker_hours(start_time, end_time)

        # First match wins.  Neither state hides or blocks the line — it comes
        # back unticked with the reason spelled out, and the user may still
        # bill it.
        if not end_time:
            include_by_default = False
            duplicate_reason = (
                "Still running — it has no end time, so there are no hours to derive."
            )
        elif sessions_by_tracker.get(doc.id):
            include_by_default = False
            duplicate_reason = (
                f"Its {sessions_by_tracker[doc.id]} time entries are already listed "
                "above as their own lines. Billing both charges the same hours twice."
            )
        else:
            include_by_default = True
            duplicate_reason = None

        lines.append(
            {
                "line_id": str(uuid.uuid4()),
                "task_id": None,
                "task_title": title,
                "project_id": project_id,
                "project_name": project_name,
                "description": title,
                "date_from": date_from,
                "date_to": _entry_date(end_time) or date_from,
                "hours": hours if hours is not None else 0.0,
                "rate": resolve_rate(
                    None, projects.get(project_id), client_data, settings_default_rate
                ),
                # Deliberately empty.  A tracker line bills the span, not the
                # entries, so claiming them here would steal the claim from the
                # time-entry lines that actually charge for them.
                "session_ids": [],
                "sub_items": [task.get("title", "") for task in task_datas],
                "tracker_id": doc.id,
                "source": "tracker",
                "claimed_entry_count": 1 if claim_ids else 0,
                "claimed_by": _claim_labels(claim_ids, claim_numbers),
                "include_by_default": include_by_default,
                "duplicate_reason": duplicate_reason,
            }
        )

    lines.sort(key=lambda line: (line["date_from"] or "", line["task_title"] or ""))
    money = compute_money(lines, None, 0.0, 0.0)
    tracker_lines = [
        line for line in money["lines"] if line.get("source") == "tracker"
    ]

    return InvoicePreviewResponse(
        client_id=payload.client_id,
        client_name=client_data.get("name", ""),
        currency=resolve_currency(
            client_data, settings_data.get("default_currency", "USD")
        ),
        period_start=payload.period_start,
        period_end=payload.period_end,
        lines=[_doc_to_preview_line(line) for line in money["lines"]],
        subtotal=money["subtotal"],
        total_hours=money["total_hours"],
        running_entry_count=running_entry_count,
        claimed_entry_count=sum(line["claimed_entry_count"] for line in money["lines"]),
        tracker_line_count=len(tracker_lines),
        duplicate_tracker_count=sum(
            1 for line in tracker_lines if line.get("include_by_default") is False
        ),
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
        or resolve_currency(client_data, settings_data.get("default_currency", "USD")),
        "lines": money["lines"],
        "subtotal": money["subtotal"],
        # Stored, not derived at render time, for the same reason as every other
        # figure here — the print view must be able to print it verbatim.
        "total_hours": money["total_hours"],
        "discount_type": discount_type,
        "discount_value": payload.discount_value,
        "discount_amount": money["discount_amount"],
        "tax_label": tax_label,
        "tax_percent": tax_percent,
        "tax_amount": money["tax_amount"],
        "total": money["total"],
        # A new invoice has no payments, but the derived fields are still
        # written so ``outstanding`` starts at the full total rather than absent.
        **_payment_figures([], money["total"]),
        "notes": notes,
        "payment_terms": payment_terms,
        "show_due_date": True if payload.show_due_date is None else payload.show_due_date,
        "show_payment_terms": (
            True if payload.show_payment_terms is None else payload.show_payment_terms
        ),
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
    _sync_tracker_links(
        db,
        doc_ref.id,
        invoice_number,
        _line_tracker_ids(money["lines"]),
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

    All monetary figures are recomputed from the submitted lines, and the
    session and tracker back-links are reconciled — anything dropped from the
    invoice is unlinked unless another invoice has since claimed it, and newly
    referenced entries and trackers are linked.  A sent or paid invoice is
    editable like any other; status never blocks a change.

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

    # Booleans, so `is not None` is the right guard — `if payload.x:` would make
    # switching a block off impossible.
    if payload.show_due_date is not None:
        updates["show_due_date"] = payload.show_due_date

    if payload.show_payment_terms is not None:
        updates["show_payment_terms"] = payload.show_payment_terms

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
    updates["total_hours"] = money["total_hours"]
    # Written back even when the payload did not touch them, so a document
    # holding a null from before the guard was fixed is repaired by any edit
    # rather than staying poisoned until someone happens to set the field.
    updates["discount_value"] = discount_value
    updates["tax_percent"] = tax_percent
    updates["discount_amount"] = money["discount_amount"]
    updates["tax_amount"] = money["tax_amount"]
    updates["total"] = money["total"]
    # Payments are never rebuilt from the payload — this endpoint does not carry
    # them — so the stored list is passed straight back through.  Without this
    # the derived figures would go stale the moment a line changed, and a
    # careless ``updates["payments"] = []`` would wipe real money records.
    updates.update(_payment_figures(_stored_payments(existing), money["total"]))
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

    new_tracker_ids = _line_tracker_ids(money["lines"])
    old_tracker_ids = _line_tracker_ids(existing.get("lines", []) or [])
    _sync_tracker_links(
        db,
        invoice_id,
        existing.get("invoice_number", ""),
        new_tracker_ids,
        [tid for tid in old_tracker_ids if tid not in set(new_tracker_ids)],
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

    Status and payments are **independent on purpose**.  Marking an invoice paid
    does not require a payment record, and recording a payment does not mark it
    paid; see the payment endpoints below.  Please do not "fix" this by deriving
    one from the other — per the no-locking principle the owner sets the status,
    and a deposit, a write-off or a paid-in-cash invoice would all fight a
    derived value.
    """
    db = get_firestore_client()
    doc_ref, doc = _fetch_invoice_ref(db, invoice_id)
    existing = doc.to_dict() or {}

    updates = {
        "status": _validate_status(payload.status),
        "datetime_updated": _now_sgt(),
    }
    # Recomputed on this write path too, so an invoice stored before payments
    # existed gains its derived fields on any edit rather than staying without
    # them until a payment happens to be recorded.
    updates.update(
        _payment_figures(_stored_payments(existing), _value_or(existing, "total", 0.0))
    )
    doc_ref.update(updates)
    return _doc_to_invoice(doc_ref.get())


@router.post(
    "/{invoice_id}/payments",
    response_model=InvoiceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_payment(
    invoice_id: str,
    payload: PaymentCreate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoiceResponse:
    """
    Record a payment against an invoice and return the whole updated invoice.

    Two amounts are stored: ``amount_paid`` in the currency the invoice was
    raised in, and ``amount_received`` in whatever currency the money actually
    landed as, so FX spread and wire fees stay visible instead of inferred.  The
    invoice's ``currency`` is snapshotted onto the payment, so re-denominating
    the invoice later never relabels money that has already arrived.

    ``received_currency`` defaults to the payout currency in invoice settings,
    then to the invoice's own currency.

    Nothing is policed: a negative amount records a refund or a correction, and
    paying more than the total simply drives ``outstanding`` negative.  The
    invoice **status is not touched** — recording a payment does not mark an
    invoice paid.

    - Pass ``notes="null"`` to store no note.  ``received_currency`` does *not*
      take that sentinel and rejects it — see ``_validate_received_currency``.
    """
    db = get_firestore_client()
    doc_ref, doc = _fetch_invoice_ref(db, invoice_id)
    existing = doc.to_dict() or {}

    # Validate everything before touching the document, so a bad request 400s
    # without leaving the invoice half-written.
    paid_on = _validate_paid_on(payload.paid_on)
    amount_paid = _validate_amount(payload.amount_paid, "amount_paid")
    amount_received = _validate_amount(payload.amount_received, "amount_received")

    invoice_currency = _value_or(existing, "currency", "")
    received_currency = _resolve_received_currency(
        payload.received_currency, get_invoice_settings(db), invoice_currency
    )
    notes = None if payload.notes is None else _clear_sentinel(payload.notes)

    now = _now_sgt()
    payments = _stored_payments(existing)
    payments.append(
        {
            "payment_id": uuid.uuid4().hex,
            "paid_on": paid_on,
            "amount_paid": amount_paid,
            # Snapshot, like ``bill_to`` and a line's ``task_title``.
            "currency": invoice_currency,
            "amount_received": amount_received,
            "received_currency": received_currency,
            # ``rate`` is left to compute_payments, which always derives it.
            "notes": notes,
            "datetime_inserted": now,
            "datetime_updated": now,
        }
    )

    _write_payments(doc_ref, payments, _value_or(existing, "total", 0.0))
    return _doc_to_invoice(doc_ref.get())


@router.patch("/{invoice_id}/payments/{payment_id}", response_model=InvoiceResponse)
async def update_payment(
    invoice_id: str,
    payment_id: str,
    payload: PaymentUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoiceResponse:
    """
    Update one payment and return the whole updated invoice.

    Only fields present in the payload change; every other key on the payment —
    including its ``currency`` snapshot and ``datetime_inserted`` — is left
    exactly as stored.  The derived figures are recomputed from the full list
    afterwards, and the invoice status is left alone.

    - Pass ``notes="null"`` to clear the note.
    - ``received_currency`` rejects that sentinel and ignores a blank string,
      leaving the stored currency in place: there is no "no currency" state.
    """
    db = get_firestore_client()
    doc_ref, doc = _fetch_invoice_ref(db, invoice_id)
    existing = doc.to_dict() or {}

    payments = _stored_payments(existing)
    index = _find_payment(payments, payment_id)

    # Validate before mutating, as on create.
    updated = dict(payments[index])
    if payload.paid_on is not None:
        updated["paid_on"] = _validate_paid_on(payload.paid_on)
    if payload.amount_paid is not None:
        updated["amount_paid"] = _validate_amount(payload.amount_paid, "amount_paid")
    if payload.amount_received is not None:
        updated["amount_received"] = _validate_amount(
            payload.amount_received, "amount_received"
        )
    if payload.received_currency is not None:
        # Rejects "null"; a blank means "leave it" rather than blanking the
        # currency printed beside the money.
        chosen = _validate_received_currency(payload.received_currency)
        if chosen:
            updated["received_currency"] = chosen
    if payload.notes is not None:
        updated["notes"] = _clear_sentinel(payload.notes)

    updated["datetime_updated"] = _now_sgt()
    payments[index] = updated

    _write_payments(doc_ref, payments, _value_or(existing, "total", 0.0))
    return _doc_to_invoice(doc_ref.get())


@router.delete("/{invoice_id}/payments/{payment_id}", response_model=InvoiceResponse)
async def delete_payment(
    invoice_id: str,
    payment_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoiceResponse:
    """
    Remove a payment and return the whole updated invoice.

    The derived figures are recomputed from what remains.  The status is not
    touched — deleting the last payment does not un-mark a paid invoice.
    """
    db = get_firestore_client()
    doc_ref, doc = _fetch_invoice_ref(db, invoice_id)
    existing = doc.to_dict() or {}

    payments = _stored_payments(existing)
    del payments[_find_payment(payments, payment_id)]

    _write_payments(doc_ref, payments, _value_or(existing, "total", 0.0))
    return _doc_to_invoice(doc_ref.get())


@router.delete("/{invoice_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_invoice(
    invoice_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> None:
    """
    Delete an invoice and clear the back-links on its time entries and trackers.

    Only documents still linked to this invoice are cleared — any that have
    since been pulled onto another invoice keep that newer link.
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
    _sync_tracker_links(
        db,
        invoice_id,
        existing.get("invoice_number", ""),
        [],
        _line_tracker_ids(existing.get("lines", []) or []),
    )
    doc_ref.delete()
