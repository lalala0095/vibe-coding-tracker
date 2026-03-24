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
    notes: Optional[str] = None
    tracker_id: Optional[str] = None


class SessionUpdate(BaseModel):
    task_id: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
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


def _doc_to_session(doc) -> SessionResponse:
    data = doc.to_dict()
    start_time = data.get("start_time", "")
    end_time = data.get("end_time")
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
) -> list[SessionResponse]:
    """
    Return sessions sorted by start_time descending.

    - ``task_id``    – filter sessions belonging to a specific task.
    - ``tracker_id`` – filter sessions belonging to a specific tracker.
    """
    db = get_firestore_client()
    query = db.collection("sessions")

    # Apply equality filters before sorting to avoid composite index requirement;
    # fall back to Python sort when a filter is applied.
    if task_id is not None:
        docs = list(query.where("task_id", "==", task_id).stream())
        docs.sort(key=lambda d: d.to_dict().get("start_time", ""), reverse=True)
    elif tracker_id is not None:
        docs = list(query.where("tracker_id", "==", tracker_id).stream())
        docs.sort(key=lambda d: d.to_dict().get("start_time", ""), reverse=True)
    else:
        docs = list(
            query.order_by("start_time", direction="DESCENDING").stream()
        )

    return [_doc_to_session(doc) for doc in docs]


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
    - ``notes``      – (optional) free-text notes for the session.
    - ``tracker_id`` – (optional) link this session to an existing tracker.

    Denormalised fields ``task_title``, ``project_id``, ``project_name``,
    ``client_id``, and ``client_name`` are fetched from the task document
    automatically.  ``duration_minutes`` is computed on read.
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
