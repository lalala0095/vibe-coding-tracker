from datetime import datetime
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from auth import get_current_user
from services.firestore_service import get_firestore_client

router = APIRouter(prefix="/sessions", tags=["sessions"])

SGT = pytz.timezone("Asia/Singapore")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class SessionCreate(BaseModel):
    task_id: str
    start_time: str  # ISO-8601 datetime string
    end_time: Optional[str] = None
    hours: Optional[float] = None  # manual override; None = use the timer value
    billable: bool = True
    notes: Optional[str] = None
    tracker_id: Optional[str] = None


class SessionUpdate(BaseModel):
    task_id: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    hours: Optional[float] = None  # omit to keep, null to clear the override
    billable: Optional[bool] = None
    notes: Optional[str] = None
    tracker_id: Optional[str] = None


class SessionResponse(BaseModel):
    id: str
    task_id: str
    task_title: str
    project_id: str
    project_name: str
    client_id: str
    client_name: str
    tracker_id: Optional[str]
    start_time: str
    end_time: Optional[str]
    duration_minutes: Optional[int]
    hours: Optional[float]
    effective_hours: float
    billable: bool
    invoice_id: Optional[str]
    invoice_number: Optional[str]
    invoice_ids: list[str]
    invoice_numbers: list[str]
    notes: Optional[str]
    datetime_inserted: str
    datetime_updated: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_sgt() -> str:
    """Return current datetime as ISO-8601 string in Singapore time (UTC+8)."""
    return datetime.now(tz=SGT).isoformat()


def _compute_duration(start_time: str, end_time: Optional[str]) -> Optional[int]:
    """Return duration in whole minutes, or None if end_time is absent."""
    if not end_time:
        return None
    try:
        start = datetime.fromisoformat(start_time)
        end = datetime.fromisoformat(end_time)
        delta = end - start
        return max(0, int(delta.total_seconds() / 60))
    except (ValueError, TypeError):
        return None


def compute_effective_hours(
    hours: Optional[float], start_time: str, end_time: Optional[str]
) -> float:
    """
    Return the hours to bill for a session.

    A manual ``hours`` override always wins — including an explicit ``0.0``,
    which is a real user choice and not an unset value.  Without an override,
    fall back to the timer duration, or ``0.0`` while the entry is still
    running.  Shared with the invoices router so both agree on one rule.
    """
    if hours is not None:
        return round(float(hours), 2)
    duration = _compute_duration(start_time, end_time)
    if duration is None:
        return 0.0
    return round(duration / 60, 2)


def invoice_claims(data: dict) -> tuple:
    """
    Return ``(invoice_ids, invoice_numbers)`` for a session document.

    An entry can sit on more than one invoice — a corrected re-issue bills the
    same hours again — so the claim is a list.  The scalar ``invoice_id`` and
    ``invoice_number`` are kept as the most recent claimant for display and are
    derived from the tail of these lists, never read directly.

    A legacy document written before the lists existed carries only the scalar
    pair; it reads here as a single-element list, so no data migration is
    needed.  Shared with the invoices router so both agree on one rule.
    """
    ids = [i for i in (data.get("invoice_ids") or []) if i]
    if ids:
        numbers = list(data.get("invoice_numbers") or [])
        numbers += [""] * (len(ids) - len(numbers))
        return ids, numbers[: len(ids)]

    scalar_id = data.get("invoice_id")
    if scalar_id:
        return [scalar_id], [data.get("invoice_number") or ""]

    return [], []


def _validate_hours(hours: Optional[float]) -> Optional[float]:
    """
    Round a manual hours override to 2dp, or return None to clear it.

    Only negative values are rejected — an hours value that disagrees with
    ``start_time``/``end_time`` is the user's call, never an error.
    """
    if hours is None:
        return None
    if hours < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Field 'hours' cannot be negative.",
        )
    return round(float(hours), 2)


def _local_date(start_time: Optional[str]) -> Optional[str]:
    """
    Return the local (SGT) ``YYYY-MM-DD`` date of an ISO-8601 timestamp.

    Every timestamp in this app is already written in SGT, so the date portion
    needs no conversion.  Returns None for missing or malformed values.
    """
    if not start_time or len(start_time) < 10:
        return None
    return start_time[:10]


def _doc_to_session(doc) -> SessionResponse:
    data = doc.to_dict()
    start_time = data.get("start_time", "")
    end_time = data.get("end_time")
    hours = data.get("hours")
    return SessionResponse(
        id=doc.id,
        task_id=data.get("task_id", ""),
        task_title=data.get("task_title", ""),
        project_id=data.get("project_id", ""),
        project_name=data.get("project_name", ""),
        client_id=data.get("client_id", ""),
        client_name=data.get("client_name", ""),
        tracker_id=data.get("tracker_id"),
        start_time=start_time,
        end_time=end_time,
        duration_minutes=_compute_duration(start_time, end_time),
        hours=hours,
        effective_hours=compute_effective_hours(hours, start_time, end_time),
        billable=data.get("billable", True),
        invoice_id=invoice_ids[-1] if invoice_ids else None,
        invoice_number=(invoice_numbers[-1] or None) if invoice_numbers else None,
        invoice_ids=invoice_ids,
        invoice_numbers=invoice_numbers,
        notes=data.get("notes"),
        datetime_inserted=data.get("datetime_inserted", ""),
        datetime_updated=data.get("datetime_updated", ""),
    )


def _fetch_task_fields(db, task_id: str) -> dict:
    """Fetch task and return denormalised fields. Raises 404 if not found."""
    doc = db.collection("tasks").document(task_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_id}' not found.",
        )
    data = doc.to_dict()
    return {
        "task_title": data.get("title", ""),
        "project_id": data.get("project_id", ""),
        "project_name": data.get("project_name", ""),
        "client_id": data.get("client_id", ""),
        "client_name": data.get("client_name", ""),
    }


def _validate_tracker(db, tracker_id: str) -> None:
    """Raise 404 if the tracker does not exist."""
    doc = db.collection("trackers").document(tracker_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tracker '{tracker_id}' not found.",
        )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[SessionResponse])
async def list_sessions(
    _user: Annotated[dict, Depends(get_current_user)],
    task_id: Optional[str] = None,
    tracker_id: Optional[str] = None,
    client_id: Optional[str] = None,
    project_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    billable: Optional[bool] = None,
    uninvoiced_only: Optional[bool] = None,
) -> list[SessionResponse]:
    """
    Return sessions sorted by start_time descending.

    - ``task_id``        – filter sessions belonging to a specific task.
    - ``tracker_id``     – filter sessions belonging to a specific tracker.
    - ``client_id``      – filter sessions belonging to a specific client.
    - ``project_id``     – filter sessions belonging to a specific project.
    - ``date_from``      – ``YYYY-MM-DD``, inclusive, on the local (SGT) date
      of ``start_time``.
    - ``date_to``        – ``YYYY-MM-DD``, inclusive, same basis.
    - ``billable``       – keep only sessions with this billable flag.
    - ``uninvoiced_only`` – when true, drop sessions already on an invoice.
    """
    db = get_firestore_client()
    query = db.collection("sessions")

    # Apply a single equality filter in Firestore — most selective first — to
    # avoid a composite index requirement; every remaining filter and the sort
    # are applied in Python.
    equality_filters = (
        ("task_id", task_id),
        ("tracker_id", tracker_id),
        ("project_id", project_id),
        ("client_id", client_id),
    )
    applied_field: Optional[str] = None
    docs: Optional[list] = None
    for field, value in equality_filters:
        if value is not None:
            applied_field = field
            docs = list(query.where(field, "==", value).stream())
            break
    if docs is None:
        docs = list(query.order_by("start_time", direction="DESCENDING").stream())

    remaining_filters = [
        (field, value)
        for field, value in equality_filters
        if value is not None and field != applied_field
    ]

    matched = []
    for doc in docs:
        data = doc.to_dict()

        if any(data.get(field) != value for field, value in remaining_filters):
            continue

        if date_from or date_to:
            entry_date = _local_date(data.get("start_time"))
            if entry_date is None:
                continue
            if date_from and entry_date < date_from:
                continue
            if date_to and entry_date > date_to:
                continue

        if billable is not None and bool(data.get("billable", True)) != billable:
            continue

        if uninvoiced_only and data.get("invoice_id"):
            continue

        matched.append(doc)

    matched.sort(key=lambda d: d.to_dict().get("start_time", ""), reverse=True)

    return [_doc_to_session(doc) for doc in matched]


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(
    session_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> SessionResponse:
    """Return a single session by its Firestore document ID."""
    db = get_firestore_client()
    doc = db.collection("sessions").document(session_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session '{session_id}' not found.",
        )
    return _doc_to_session(doc)


@router.post("", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> SessionResponse:
    """
    Create a new session linked to a task.

    - ``task_id``    – ID of an existing task (required).
    - ``start_time`` – ISO-8601 datetime when the session started (required).
    - ``end_time``   – (optional) ISO-8601 datetime when the session ended.
    - ``hours``      – (optional) manual hours override.  Omit or send null to
      fall back to the timer.  Never validated against start/end.
    - ``billable``   – (optional) defaults to true.
    - ``notes``      – (optional) free-text notes for the session.
    - ``tracker_id`` – (optional) link this session to an existing tracker.

    Denormalised fields ``task_title``, ``project_id``, ``project_name``,
    ``client_id``, and ``client_name`` are fetched from the task document
    automatically.  ``duration_minutes`` is computed on read, and
    ``effective_hours`` resolves ``hours`` against it.  ``invoice_id`` and
    ``invoice_number`` are written only by the invoices router.
    """
    db = get_firestore_client()

    task_fields = _fetch_task_fields(db, payload.task_id)

    if payload.tracker_id:
        _validate_tracker(db, payload.tracker_id)

    now = _now_sgt()
    _, doc_ref = db.collection("sessions").add(
        {
            "task_id": payload.task_id,
            **task_fields,
            "tracker_id": payload.tracker_id,
            "start_time": payload.start_time,
            "end_time": payload.end_time,
            "hours": _validate_hours(payload.hours),
            "billable": payload.billable,
            "invoice_id": None,
            "invoice_number": None,
            "notes": payload.notes,
            "datetime_inserted": now,
            "datetime_updated": now,
        }
    )
    doc = doc_ref.get()
    return _doc_to_session(doc)


@router.put("/{session_id}", response_model=SessionResponse)
async def update_session(
    session_id: str,
    payload: SessionUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> SessionResponse:
    """
    Update an existing session.

    - When ``task_id`` changes, denormalised task fields are refreshed.
    - Pass ``end_time="null"`` or ``tracker_id="null"`` to clear those fields.
    - Only non-None fields in the payload are updated.

    ``hours`` is the exception: being numeric it cannot use the ``"null"``
    string sentinel, so presence is read from ``model_fields_set``.  Omitting
    the key leaves the override untouched; sending JSON ``null`` clears it so
    ``effective_hours`` falls back to the timer value.  An hours value is never
    rejected for disagreeing with ``start_time``/``end_time``, and a session
    already carrying an ``invoice_id`` stays fully editable — only a negative
    value is refused.
    """
    db = get_firestore_client()
    doc_ref = db.collection("sessions").document(session_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session '{session_id}' not found.",
        )

    updates: dict = {}

    if payload.task_id is not None:
        task_fields = _fetch_task_fields(db, payload.task_id)
        updates["task_id"] = payload.task_id
        updates.update(task_fields)

    if payload.start_time is not None:
        updates["start_time"] = payload.start_time

    if payload.end_time is not None:
        updates["end_time"] = None if payload.end_time.lower() == "null" else payload.end_time

    if "hours" in payload.model_fields_set:
        updates["hours"] = _validate_hours(payload.hours)

    if payload.billable is not None:
        updates["billable"] = payload.billable

    if payload.notes is not None:
        updates["notes"] = None if payload.notes.lower() == "null" else payload.notes

    if payload.tracker_id is not None:
        if payload.tracker_id.lower() == "null":
            updates["tracker_id"] = None
        else:
            _validate_tracker(db, payload.tracker_id)
            updates["tracker_id"] = payload.tracker_id

    if updates:
        updates["datetime_updated"] = _now_sgt()
        doc_ref.update(updates)

    updated_doc = doc_ref.get()
    return _doc_to_session(updated_doc)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> None:
    """Delete a session."""
    db = get_firestore_client()
    doc_ref = db.collection("sessions").document(session_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session '{session_id}' not found.",
        )
    doc_ref.delete()
