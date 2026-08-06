from datetime import datetime
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from auth import get_current_user
from routers.sessions import SessionResponse, _doc_to_session
from routers.tasks import _fetch_project
from services.firestore_service import get_firestore_client

router = APIRouter(prefix="/trackers", tags=["trackers"])

SGT = pytz.timezone("Asia/Singapore")

VALID_SPLITS = ("even", "full")

# The values the tasks router accepts, mirrored here so a task created
# alongside a tracker is indistinguishable from one created any other way.
VALID_TASK_STATUSES = ("todo", "in_progress", "done")
VALID_TASK_PRIORITIES = ("low", "medium", "high", "urgent")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class TaskRef(BaseModel):
    task_id: str
    task_title: str
    project_name: str
    client_name: str


class NewTrackerTask(BaseModel):
    """
    A task to create alongside the tracker, in the same request.

    A tracker on its own carries no billable time and no project; giving it a
    task is what makes its hours reachable from an invoice.
    """

    project_id: str  # required — a task cannot exist without one
    title: Optional[str] = None  # defaults to the tracker's title
    status: str = "in_progress"
    priority: str = "medium"


class TrackerCreate(BaseModel):
    title: str
    start_time: str  # ISO-8601 datetime string
    end_time: Optional[str] = None
    notes: Optional[str] = None
    task_ids: list[str] = []
    new_task: Optional[NewTrackerTask] = None


class TrackerUpdate(BaseModel):
    title: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    notes: Optional[str] = None


class TrackerAddTasks(BaseModel):
    task_ids: list[str]


class TrackerBillRequest(BaseModel):
    """
    How to turn a tracker's elapsed time into billable time entries.

    ``hours`` overrides the tracker's own span, which is what makes a still
    running tracker billable without stopping it.
    """

    split: str = "even"  # "even" – share the hours out | "full" – each task gets all
    hours: Optional[float] = None
    billable: bool = True
    task_ids: Optional[list[str]] = None  # default: every task on the tracker


class TrackerResponse(BaseModel):
    id: str
    title: str
    start_time: str
    end_time: Optional[str]
    notes: Optional[str]
    tasks: list[TaskRef]
    # Written only by the invoices router, when an invoice bills the tracker as
    # a line of its own.  Informational — a claimed tracker stays fully editable
    # and can be billed again.
    invoice_ids: list[str] = []
    invoice_numbers: list[str] = []
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
        # ``or []`` as well as the default: a tracker written before invoicing
        # existed has no key, and one written by an older path may hold null.
        invoice_ids=data.get("invoice_ids", []) or [],
        invoice_numbers=data.get("invoice_numbers", []) or [],
        datetime_inserted=data.get("datetime_inserted", ""),
        datetime_updated=data.get("datetime_updated", ""),
    )


def _tracker_hours(start_time: str, end_time: Optional[str]) -> Optional[float]:
    """
    Return a tracker's elapsed hours to 2dp, or None when it cannot be derived.

    None means the tracker is still running or its timestamps are unparseable —
    the caller must then supply hours explicitly.
    """
    if not end_time:
        return None
    try:
        delta = datetime.fromisoformat(end_time) - datetime.fromisoformat(start_time)
    except (ValueError, TypeError):
        return None
    return round(max(0.0, delta.total_seconds() / 3600), 2)


def _split_hours(total: float, count: int, split: str) -> list[float]:
    """
    Share ``total`` hours across ``count`` time entries.

    ``"full"`` bills the whole span against every task — right when the tasks
    were worked in parallel.  ``"even"`` divides it, and the rounding remainder
    lands on the first entry so the parts add back up to the total exactly
    rather than losing a cent's worth of time to three-way rounding.

    ``count`` must be the number of entries that will actually be written.  A
    caller that discards a share after the fact silently loses those hours.
    """
    if count <= 0:
        return []
    if split == "full":
        return [round(total, 2)] * count

    each = round(total / count, 2)
    parts = [each] * count
    parts[0] = round(total - each * (count - 1), 2)
    return parts


def _validate_split(value: str) -> str:
    """
    Check a split mode against the known set.

    Anything unrecognised used to fall through to ``"even"``, so a typo such as
    ``"Full"`` quietly divided the hours instead of duplicating them.  Rejecting
    it is a correction of the request, not a constraint on the user's hours.
    """
    if value not in VALID_SPLITS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Split must be one of: {', '.join(VALID_SPLITS)}.",
        )
    return value


def _validate_task_status(value: str) -> str:
    """
    Check a task status against the set the tasks router documents.

    Case-sensitive on purpose: ``"In_Progress"`` is stored verbatim by the
    tasks router and would then never match the tasks list's status filter, so
    it is refused here rather than written and lost.
    """
    if value not in VALID_TASK_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Status must be one of: {', '.join(VALID_TASK_STATUSES)}.",
        )
    return value


def _validate_task_priority(value: str) -> str:
    """Check a task priority against the set the tasks router documents."""
    if value not in VALID_TASK_PRIORITIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Priority must be one of: {', '.join(VALID_TASK_PRIORITIES)}.",
        )
    return value


def _existing_tracker_task_ids(db, tracker_id: str) -> set:
    """
    Return the task ids that already have a time entry for this tracker.

    Billing a tracker twice must not double the hours, so the second call skips
    what the first one wrote.  Entries the user has since deleted are billed
    again, which is the intent.
    """
    docs = db.collection("sessions").where("tracker_id", "==", tracker_id).stream()
    return {(doc.to_dict() or {}).get("task_id") for doc in docs}


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


def _resolve_tracker_tasks(db, task_refs: list[dict]) -> list[tuple[str, dict]]:
    """
    Resolve a tracker's TaskRefs to live task documents in one round trip.

    Returns ``[(task_id, task_data), ...]`` for the tasks that still exist, in
    the order they appear on the tracker.  Deleting a task does not strip its
    TaskRef from ``tracker.tasks``, so a tracker routinely points at documents
    that are gone; those are dropped here rather than by the caller.

    ``db.get_all`` does not promise to return snapshots in the order the refs
    were passed, hence the id-keyed map and the re-walk of ``task_refs``.
    """
    ordered_ids = [t.get("task_id", "") for t in task_refs]
    unique_ids = [tid for tid in dict.fromkeys(ordered_ids) if tid]
    if not unique_ids:
        return []

    refs = [db.collection("tasks").document(tid) for tid in unique_ids]
    tasks: dict = {}
    for snapshot in db.get_all(refs):
        if snapshot.exists:
            tasks[snapshot.id] = snapshot.to_dict() or {}

    return [(tid, tasks[tid]) for tid in ordered_ids if tid in tasks]


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

    - ``task_ids``  – (optional) link existing tasks immediately; their titles
      and project/client names are denormalised automatically.
    - ``new_task``  – (optional) create a task for this tracker in the same
      request and link it ahead of ``task_ids``.  Requires ``project_id``;
      ``title`` defaults to the tracker's title and the tracker's ``notes``
      become the task's description.  ``status`` (``todo`` | ``in_progress`` |
      ``done``, default ``in_progress``) and ``priority`` (``low`` | ``medium``
      | ``high`` | ``urgent``, default ``medium``) are case-sensitive.

    A tracker on its own carries no billable time; giving it a task is what
    makes its hours reachable from an invoice.
    """
    db = get_firestore_client()

    # Validate everything before writing anything, so a bad request cannot
    # leave a half-created task/tracker pair behind.
    new_task_project: Optional[dict] = None
    if payload.new_task is not None:
        new_task_project = _fetch_project(db, payload.new_task.project_id)
        _validate_task_status(payload.new_task.status)
        _validate_task_priority(payload.new_task.priority)

    task_refs: list[dict] = []
    seen_ids: set[str] = set()
    for task_id in payload.task_ids:
        if task_id in seen_ids:
            continue
        task_refs.append(_fetch_task_ref(db, task_id))
        seen_ids.add(task_id)

    now = _now_sgt()

    new_task_ref = None
    if payload.new_task is not None and new_task_project is not None:
        new_task_ref = db.collection("tasks").document()
        new_task_title = (payload.new_task.title or "").strip() or payload.title
        new_task_ref.set(
            {
                "title": new_task_title,
                "description": payload.notes or "",
                "project_id": payload.new_task.project_id,
                "project_name": new_task_project["project_name"],
                "client_id": new_task_project["client_id"],
                "client_name": new_task_project["client_name"],
                "parent_task_id": None,
                "status": payload.new_task.status,
                "priority": payload.new_task.priority,
                "due_date": None,
                "attachments": [],
                "datetime_inserted": now,
                "datetime_updated": now,
            }
        )
        # Prepend, and drop any ref ``task_ids`` already produced for the same
        # id, so passing both cannot yield two refs to one task.
        task_refs = [
            {
                "task_id": new_task_ref.id,
                "task_title": new_task_title,
                "project_name": new_task_project["project_name"],
                "client_name": new_task_project["client_name"],
            }
        ] + [t for t in task_refs if t["task_id"] != new_task_ref.id]

    try:
        _, doc_ref = db.collection("trackers").add(
            {
                "title": payload.title,
                "start_time": payload.start_time,
                "end_time": payload.end_time,
                "notes": payload.notes,
                "tasks": task_refs,
                "invoice_ids": [],
                "invoice_numbers": [],
                "datetime_inserted": now,
                "datetime_updated": now,
            }
        )
        doc = doc_ref.get()
    except Exception:
        # Compensation: the task is written first, so a tracker that fails to
        # create would otherwise leave an orphan task the user never asked for.
        if new_task_ref is not None:
            new_task_ref.delete()
        raise

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


@router.post(
    "/{tracker_id}/time-entries",
    response_model=list[SessionResponse],
    status_code=status.HTTP_201_CREATED,
)
async def bill_tracker(
    tracker_id: str,
    payload: TrackerBillRequest,
    _user: Annotated[dict, Depends(get_current_user)],
) -> list[SessionResponse]:
    """
    Turn a tracker's elapsed time into billable time entries.

    This is the bridge from a tracker to an invoice.  A tracker on its own is a
    grouping and carries no billable time; only the ``sessions`` collection
    feeds the invoice preview.  One time entry is created per linked task,
    spanning the tracker's start and end, with the hours written as a manual
    override so they stay editable afterwards.

    - ``split``     – ``"even"`` divides the elapsed hours across the tasks;
      ``"full"`` bills the whole span against each of them.
    - ``hours``     – (optional) use this total instead of the tracker's span.
      Required while the tracker is still running.
    - ``task_ids``  – (optional) bill only these tasks; defaults to all of them.
    - ``billable``  – (optional) defaults to true.

    Tasks that have since been deleted are dropped before the hours are
    divided, so an ``"even"`` split always adds back up to the total.

    Re-running skips tasks that already have an entry for this tracker, so
    billing twice never doubles the hours.  Everything written here is a
    starting point: hours, dates and the billable flag stay fully editable on
    the Time Entries page.
    """
    _validate_split(payload.split)

    db = get_firestore_client()
    doc_ref = db.collection("trackers").document(tracker_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tracker '{tracker_id}' not found.",
        )

    data = doc.to_dict() or {}
    tracker_tasks: list[dict] = data.get("tasks", [])

    if payload.task_ids is not None:
        wanted = set(payload.task_ids)
        tracker_tasks = [t for t in tracker_tasks if t.get("task_id") in wanted]

    if not tracker_tasks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Add at least one task to the tracker before billing it.",
        )

    if payload.hours is not None:
        if payload.hours < 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Field 'hours' cannot be negative.",
            )
        total_hours = round(float(payload.hours), 2)
    else:
        derived = _tracker_hours(data.get("start_time", ""), data.get("end_time"))
        if derived is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Stop the tracker or supply 'hours' before billing it.",
            )
        total_hours = derived

    already_billed = _existing_tracker_task_ids(db, tracker_id)
    pending = [t for t in tracker_tasks if t.get("task_id") not in already_billed]
    if not pending:
        return []

    # Resolve the tasks BEFORE splitting, never after.  The shares list is
    # index-aligned with the tasks it was sized for, so skipping a task inside
    # the write loop threw its share away instead of redistributing it — a
    # tracker with a deleted task silently billed less than the total.  Read the
    # tasks fresh rather than trusting the denormalised copy on the tracker: a
    # time entry needs project_id and client_id, which the TaskRef does not
    # carry.  Do not move the split back above this call.
    resolved = _resolve_tracker_tasks(db, pending)
    if not resolved:
        return []

    shares = _split_hours(total_hours, len(resolved), payload.split)

    now = _now_sgt()
    created = []
    for (task_id, task_data), hours in zip(resolved, shares):
        _, session_ref = db.collection("sessions").add(
            {
                "task_id": task_id,
                "task_title": task_data.get("title", ""),
                "project_id": task_data.get("project_id", ""),
                "project_name": task_data.get("project_name", ""),
                "client_id": task_data.get("client_id", ""),
                "client_name": task_data.get("client_name", ""),
                "tracker_id": tracker_id,
                "start_time": data.get("start_time", ""),
                "end_time": data.get("end_time"),
                # Stored as an override so the split survives — the tracker's
                # span would otherwise recompute every entry to the full length.
                "hours": hours,
                "billable": payload.billable,
                "invoice_id": None,
                "invoice_number": None,
                "invoice_ids": [],
                "invoice_numbers": [],
                "notes": data.get("notes"),
                "datetime_inserted": now,
                "datetime_updated": now,
            }
        )
        created.append(_doc_to_session(session_ref.get()))

    return created


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
