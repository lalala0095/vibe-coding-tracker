from datetime import datetime
from typing import Annotated, Optional
from zoneinfo import ZoneInfo

import pytz
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel

from auth import get_current_user
from services.firestore_service import get_firestore_client
from services.storage_service import delete_file, upload_file

router = APIRouter(prefix="/goals", tags=["goals"])

SGT = pytz.timezone("Asia/Singapore")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class AttachmentInfo(BaseModel):
    name: str
    gcs_url: str


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
        AttachmentInfo(name=a["name"], gcs_url=a["gcs_url"])
        for a in data.get("attachments", [])
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


def _fetch_task_title(db, task_id: str) -> str:
    """Fetch the task title from Firestore. Raises 404 if not found."""
    doc = db.collection("tasks").document(task_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_id}' not found.",
        )
    return doc.to_dict()["title"]


def _fetch_model_name(db, model_id: str) -> str:
    """Fetch the model name from Firestore. Raises 404 if not found."""
    doc = db.collection("models").document(model_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Model '{model_id}' not found.",
        )
    return doc.to_dict()["name"]


def _blob_name_from_url(gcs_url: str, bucket_name: str) -> str:
    """Extract the blob path from a public GCS URL."""
    prefix = f"https://storage.googleapis.com/{bucket_name}/"
    if gcs_url.startswith(prefix):
        return gcs_url[len(prefix):]
    # Fallback: strip everything up to the bucket name segment
    return gcs_url.split(f"/{bucket_name}/", 1)[-1]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[GoalResponse])
async def list_goals(
    _user: Annotated[dict, Depends(get_current_user)],
    task_id: Optional[str] = None,
) -> list[GoalResponse]:
    """Return all goals sorted by datetime_inserted descending. Filter by task_id if provided."""
    db = get_firestore_client()
    if task_id:
        # Combining where() on task_id with order_by() on datetime_inserted requires a
        # composite index. Sort in Python instead to avoid the Firestore index requirement.
        docs = list(db.collection("goals").where("task_id", "==", task_id).stream())
        docs.sort(key=lambda d: d.to_dict().get("datetime_inserted", ""), reverse=True)
    else:
        docs = list(
            db.collection("goals")
            .order_by("datetime_inserted", direction="DESCENDING")
            .stream()
        )
    return [_doc_to_goal(doc) for doc in docs]


@router.get("/{goal_id}", response_model=GoalResponse)
async def get_goal(
    goal_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> GoalResponse:
    """Return a single goal by its Firestore document ID."""
    db = get_firestore_client()
    doc = db.collection("goals").document(goal_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Goal '{goal_id}' not found.",
        )
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
    to GCS under ``goals/<goal_id>/<original_filename>``.
    """
    db = get_firestore_client()

    # Validate model and fetch model_name
    model_name = _fetch_model_name(db, model_id)

    # Optionally link to a task
    task_title: Optional[str] = None
    if task_id:
        task_title = _fetch_task_title(db, task_id)

    # Create a bare document first so we have the goal_id for GCS paths
    doc_ref = db.collection("goals").document()
    goal_id = doc_ref.id

    # Upload attachments to GCS
    attachment_records: list[dict] = []
    for upload in attachments:
        if not upload.filename:
            continue
        file_bytes = await upload.read()
        blob_name = f"goals/{goal_id}/{upload.filename}"
        content_type = upload.content_type or "application/octet-stream"
        public_url = upload_file(file_bytes, blob_name, content_type)
        attachment_records.append({"name": upload.filename, "gcs_url": public_url})

    # Persist the goal document
    goal_data = {
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
    db = get_firestore_client()
    doc_ref = db.collection("goals").document(goal_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Goal '{goal_id}' not found.",
        )

    updates: dict = {}

    if payload.goal is not None:
        updates["goal"] = payload.goal

    if payload.output is not None:
        updates["output"] = payload.output

    if payload.model_id is not None:
        model_name = _fetch_model_name(db, payload.model_id)
        updates["model_id"] = payload.model_id
        updates["model_name"] = model_name

    if payload.task_id is not None:
        if payload.task_id == "":
            updates["task_id"] = None
            updates["task_title"] = None
        else:
            updates["task_title"] = _fetch_task_title(db, payload.task_id)
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
    import logging
    import os

    logger = logging.getLogger(__name__)

    db = get_firestore_client()
    doc_ref = db.collection("goals").document(goal_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Goal '{goal_id}' not found.",
        )

    data = doc.to_dict()
    bucket_name = os.getenv("GCS_BUCKET_NAME", "")

    # Delete GCS attachments
    for attachment in data.get("attachments", []):
        gcs_url = attachment.get("gcs_url", "")
        if not gcs_url:
            continue
        blob_name = _blob_name_from_url(gcs_url, bucket_name)
        try:
            delete_file(blob_name)
        except Exception as exc:
            logger.warning("Failed to delete GCS blob '%s': %s", blob_name, exc)

    # Delete Firestore document
    doc_ref.delete()
