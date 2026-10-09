from datetime import datetime
from typing import Annotated, Optional
from zoneinfo import ZoneInfo

import pytz
from fastapi import APIRouter, Depends, File, Form, UploadFile, status
from pydantic import BaseModel

from auth import get_current_user, owner_id_of
from services.firestore_service import get_firestore_client, get_owned_doc, owned_query
from services.storage_service import (
    delete_attachments,
    owned_blob_name,
    signed_attachments,
    upload_file,
)

router = APIRouter(prefix="/goals", tags=["goals"])

SGT = pytz.timezone("Asia/Singapore")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class AttachmentInfo(BaseModel):
    name: str
    # A short-lived signed URL (the bucket is private), minted on every read.
    # ``None`` when it could not be signed.  Never stored.
    gcs_url: Optional[str] = None


class GoalResponse(BaseModel):
    id: str
    datetime_inserted: str
    model_id: str
    model_name: str
    goal: str
    attachments: list[AttachmentInfo]
    output: Optional[str] = None
    task_id: Optional[str] = None
    task_title: Optional[str] = None


class GoalUpdate(BaseModel):
    goal: Optional[str] = None
    output: Optional[str] = None
    model_id: Optional[str] = None
    task_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_sgt() -> str:
    """Return current datetime as ISO-8601 string in Singapore time (UTC+8)."""
    return datetime.now(tz=SGT).isoformat()


def _doc_to_goal(doc) -> GoalResponse:
    data = doc.to_dict()
    attachments = [
        AttachmentInfo(**a)
        for a in signed_attachments(
            data.get("attachments", []), data.get("owner_id"), "goals", doc.id
        )
    ]
    return GoalResponse(
        id=doc.id,
        datetime_inserted=data.get("datetime_inserted", ""),
        model_id=data.get("model_id", ""),
        model_name=data.get("model_name", ""),
        goal=data.get("goal", ""),
        attachments=attachments,
        output=data.get("output"),
        task_id=data.get("task_id"),
        task_title=data.get("task_title"),
    )


def _fetch_task_title(db, task_id: str, owner_id: str) -> str:
    """Fetch the caller's task title. Raises 404 if missing or not theirs."""
    doc = get_owned_doc(db, "tasks", task_id, owner_id, "Task")
    return (doc.to_dict() or {}).get("title", "")


def _fetch_model_name(db, model_id: str, owner_id: str) -> str:
    """Fetch the caller's model name. Raises 404 if missing or not theirs."""
    doc = get_owned_doc(db, "models", model_id, owner_id, "Model")
    return (doc.to_dict() or {}).get("name", "")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[GoalResponse])
async def list_goals(
    _user: Annotated[dict, Depends(get_current_user)],
    task_id: Optional[str] = None,
) -> list[GoalResponse]:
    """Return the caller's goals sorted by datetime_inserted descending. Filter by task_id if provided."""
    db = get_firestore_client()
    # Equality filters in Firestore, sort in Python: combining where() with
    # order_by() on datetime_inserted would require a composite index.
    query = owned_query(db, "goals", owner_id_of(_user))
    if task_id:
        query = query.where("task_id", "==", task_id)
    docs = list(query.stream())
    docs.sort(key=lambda d: (d.to_dict() or {}).get("datetime_inserted", ""), reverse=True)
    return [_doc_to_goal(doc) for doc in docs]


@router.get("/{goal_id}", response_model=GoalResponse)
async def get_goal(
    goal_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> GoalResponse:
    """Return a single goal by its Firestore document ID."""
    db = get_firestore_client()
    doc = get_owned_doc(db, "goals", goal_id, owner_id_of(_user), "Goal")
    return _doc_to_goal(doc)


@router.post("", response_model=GoalResponse, status_code=status.HTTP_201_CREATED)
async def create_goal(
    _user: Annotated[dict, Depends(get_current_user)],
    model_id: str = Form(...),
    goal: str = Form(...),
    output: Optional[str] = Form(default=None),
    task_id: Optional[str] = Form(default=None),
    attachments: list[UploadFile] = File(default=[]),
) -> GoalResponse:
    """
    Create a new goal.

    Accepts ``multipart/form-data`` with:
    - ``model_id``   – ID of an existing model document.
    - ``goal``       – Prompt / description sent to the AI.
    - ``output``     – (optional) AI response.
    - ``attachments``– (optional, repeatable) file uploads.

    The endpoint auto-populates ``datetime_inserted`` (Singapore TZ) and
    ``model_name`` (fetched from the models collection).  Files are uploaded
    to GCS under ``<owner_id>/goals/<goal_id>/<original_filename>``.
    """
    owner_id = owner_id_of(_user)
    db = get_firestore_client()

    # Validate model and fetch model_name
    model_name = _fetch_model_name(db, model_id, owner_id)

    # Optionally link to a task
    task_title: Optional[str] = None
    if task_id:
        task_title = _fetch_task_title(db, task_id, owner_id)

    # Create a bare document first so we have the goal_id for GCS paths
    doc_ref = db.collection("goals").document()
    goal_id = doc_ref.id

    # Upload attachments to GCS
    attachment_records: list[dict] = []
    for upload in attachments:
        if not upload.filename:
            continue
        file_bytes = await upload.read()
        blob_name = owned_blob_name(owner_id, "goals", goal_id, upload.filename)
        content_type = upload.content_type or "application/octet-stream"
        upload_file(file_bytes, blob_name, content_type)
        attachment_records.append({"name": upload.filename, "blob_name": blob_name})

    # Persist the goal document
    goal_data = {
        "owner_id": owner_id,
        "datetime_inserted": _now_sgt(),
        "model_id": model_id,
        "model_name": model_name,
        "goal": goal,
        "attachments": attachment_records,
        "output": output,
        "task_id": task_id,
        "task_title": task_title,
    }
    doc_ref.set(goal_data)

    doc = doc_ref.get()
    return _doc_to_goal(doc)


@router.put("/{goal_id}", response_model=GoalResponse)
async def update_goal(
    goal_id: str,
    payload: GoalUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> GoalResponse:
    """
    Update an existing goal's ``goal`` text, ``output``, and/or ``model_id``.

    When ``model_id`` changes, ``model_name`` is refreshed automatically.
    Only fields that are explicitly provided (non-None) are updated.
    """
    owner_id = owner_id_of(_user)
    db = get_firestore_client()
    doc = get_owned_doc(db, "goals", goal_id, owner_id, "Goal")
    doc_ref = doc.reference

    updates: dict = {}

    if payload.goal is not None:
        updates["goal"] = payload.goal

    if payload.output is not None:
        updates["output"] = payload.output

    if payload.model_id is not None:
        model_name = _fetch_model_name(db, payload.model_id, owner_id)
        updates["model_id"] = payload.model_id
        updates["model_name"] = model_name

    if payload.task_id is not None:
        if payload.task_id == "":
            updates["task_id"] = None
            updates["task_title"] = None
        else:
            updates["task_title"] = _fetch_task_title(db, payload.task_id, owner_id)
            updates["task_id"] = payload.task_id

    if updates:
        doc_ref.update(updates)

    updated_doc = doc_ref.get()
    return _doc_to_goal(updated_doc)


@router.delete("/{goal_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_goal(
    goal_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> None:
    """
    Delete a goal and all its GCS attachments.

    GCS blob deletion failures are logged but do not prevent the Firestore
    document from being removed.
    """
    db = get_firestore_client()
    owner_id = owner_id_of(_user)
    doc = get_owned_doc(db, "goals", goal_id, owner_id, "Goal")
    doc_ref = doc.reference

    data = doc.to_dict() or {}
    delete_attachments(data.get("attachments", []), owner_id, "goals", goal_id)

    # Delete Firestore document
    doc_ref.delete()
