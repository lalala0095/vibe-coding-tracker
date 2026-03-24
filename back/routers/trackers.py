from datetime import datetime
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from auth import get_current_user
from services.firestore_service import get_firestore_client

router = APIRouter(prefix="/trackers", tags=["trackers"])

SGT = pytz.timezone("Asia/Singapore")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class TaskRef(BaseModel):
    task_id: str
    task_title: str
    project_name: str
    client_name: str


class TrackerCreate(BaseModel):
    title: str
    start_time: str  # ISO-8601 datetime string
    end_time: Optional[str] = None
    notes: Optional[str] = None
    task_ids: list[str] = []


class TrackerUpdate(BaseModel):
    title: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    notes: Optional[str] = None


class TrackerAddTasks(BaseModel):
    task_ids: list[str]


class TrackerResponse(BaseModel):
    id: str
    title: str
    start_time: str
    end_time: Optional[str]
    notes: Optional[str]
    tasks: list[TaskRef]
    datetime_inserted: str
    datetime_updated: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_sgt() -> str:
    """Return current datetime as ISO-8601 string in Singapore time (UTC+8)."""
    return datetime.now(tz=SGT).isoformat()


def _doc_to_tracker(doc) -> TrackerResponse:
    data = doc.to_dict()
    tasks = [
        TaskRef(
            task_id=t["task_id"],
            task_title=t["task_title"],
            project_name=t["project_name"],
            client_name=t["client_name"],
        )
        for t in data.get("tasks", [])
    ]
    return TrackerResponse(
        id=doc.id,
        title=data.get("title", ""),
        start_time=data.get("start_time", ""),
        end_time=data.get("end_time"),
        notes=data.get("notes"),
        tasks=tasks,
        datetime_inserted=data.get("datetime_inserted", ""),
        datetime_updated=data.get("datetime_updated", ""),
    )


def _fetch_task_ref(db, task_id: str) -> dict:
    """Fetch a task and return its denormalized fields. Raises 404 if not found."""
    doc = db.collection("tasks").document(task_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_id}' not found.",
        )
    data = doc.to_dict()
    return {
        "task_id": task_id,
        "task_title": data.get("title", ""),
        "project_name": data.get("project_name", ""),
        "client_name": data.get("client_name", ""),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[TrackerResponse])
async def list_trackers(
    _user: Annotated[dict, Depends(get_current_user)],
    active_only: Optional[bool] = None,
) -> list[TrackerResponse]:
    """
    Return all trackers sorted by start_time descending.

    - ``active_only=true``  – only trackers without an end_time (still running).
    - ``active_only=false`` – only completed trackers.
    """
    db = get_firestore_client()
    docs = list(
        db.collection("trackers")
        .order_by("start_time", direction="DESCENDING")
        .stream()
    )
    trackers = [_doc_to_tracker(doc) for doc in docs]
    if active_only is True:
        trackers = [t for t in trackers if t.end_time is None]
    elif active_only is False:
        trackers = [t for t in trackers if t.end_time is not None]
    return trackers


@router.get("/{tracker_id}", response_model=TrackerResponse)
async def get_tracker(
    tracker_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> TrackerResponse:
    """Return a single tracker by its Firestore document ID."""
    db = get_firestore_client()
    doc = db.collection("trackers").document(tracker_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tracker '{tracker_id}' not found.",
        )
    return _doc_to_tracker(doc)


@router.post("", response_model=TrackerResponse, status_code=status.HTTP_201_CREATED)
async def create_tracker(
    payload: TrackerCreate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> TrackerResponse:
    """
    Create a new tracker.

    Optionally supply ``task_ids`` to link tasks immediately; their titles and
    project/client names are denormalised automatically.
    """
    db = get_firestore_client()

    task_refs: list[dict] = []
    seen_ids: set[str] = set()
    for task_id in payload.task_ids:
        if task_id in seen_ids:
            continue
        task_refs.append(_fetch_task_ref(db, task_id))
        seen_ids.add(task_id)

    now = _now_sgt()
    _, doc_ref = db.collection("trackers").add(
        {
            "title": payload.title,
            "start_time": payload.start_time,
            "end_time": payload.end_time,
            "notes": payload.notes,
            "tasks": task_refs,
            "datetime_inserted": now,
            "datetime_updated": now,
        }
    )
    doc = doc_ref.get()
    return _doc_to_tracker(doc)


@router.put("/{tracker_id}", response_model=TrackerResponse)
async def update_tracker(
    tracker_id: str,
    payload: TrackerUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> TrackerResponse:
    """
    Update tracker metadata (title, start_time, end_time, notes).

    Pass ``end_time=null`` as the literal string ``"null"`` to clear it
    (mark tracker as active again).  Only non-None fields are updated.
    """
    db = get_firestore_client()
    doc_ref = db.collection("trackers").document(tracker_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tracker '{tracker_id}' not found.",
        )

    updates: dict = {}

    if payload.title is not None:
        updates["title"] = payload.title

    if payload.start_time is not None:
        updates["start_time"] = payload.start_time

    if payload.end_time is not None:
        updates["end_time"] = None if payload.end_time.lower() == "null" else payload.end_time

    if payload.notes is not None:
        updates["notes"] = None if payload.notes.lower() == "null" else payload.notes

    if updates:
        updates["datetime_updated"] = _now_sgt()
        doc_ref.update(updates)

    updated_doc = doc_ref.get()
    return _doc_to_tracker(updated_doc)


@router.post("/{tracker_id}/tasks", response_model=TrackerResponse)
async def add_tasks_to_tracker(
    tracker_id: str,
    payload: TrackerAddTasks,
    _user: Annotated[dict, Depends(get_current_user)],
) -> TrackerResponse:
    """
    Add one or more tasks to a tracker.

    Duplicate task IDs (already present) are silently ignored.
    """
    db = get_firestore_client()
    doc_ref = db.collection("trackers").document(tracker_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tracker '{tracker_id}' not found.",
        )

    existing_tasks: list[dict] = doc.to_dict().get("tasks", [])
    existing_ids = {t["task_id"] for t in existing_tasks}

    new_refs: list[dict] = []
    for task_id in payload.task_ids:
        if task_id in existing_ids:
            continue
        new_refs.append(_fetch_task_ref(db, task_id))
        existing_ids.add(task_id)

    if new_refs:
        doc_ref.update(
            {
                "tasks": existing_tasks + new_refs,
                "datetime_updated": _now_sgt(),
            }
        )

    updated_doc = doc_ref.get()
    return _doc_to_tracker(updated_doc)


@router.delete("/{tracker_id}/tasks/{task_id}", response_model=TrackerResponse)
async def remove_task_from_tracker(
    tracker_id: str,
    task_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> TrackerResponse:
    """Remove a task from a tracker's task list."""
    db = get_firestore_client()
    doc_ref = db.collection("trackers").document(tracker_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tracker '{tracker_id}' not found.",
        )

    existing_tasks: list[dict] = doc.to_dict().get("tasks", [])
    filtered = [t for t in existing_tasks if t["task_id"] != task_id]

    doc_ref.update(
        {
            "tasks": filtered,
            "datetime_updated": _now_sgt(),
        }
    )

    updated_doc = doc_ref.get()
    return _doc_to_tracker(updated_doc)


@router.delete("/{tracker_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tracker(
    tracker_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> None:
    """Delete a tracker. Does not cascade to sessions."""
    db = get_firestore_client()
    doc_ref = db.collection("trackers").document(tracker_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tracker '{tracker_id}' not found.",
        )
    doc_ref.delete()
