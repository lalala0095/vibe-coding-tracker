import logging
import os
from datetime import datetime
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel

from auth import get_current_user
from services.firestore_service import get_firestore_client
from services.storage_service import delete_file, upload_file

router = APIRouter(prefix="/tasks", tags=["tasks"])

SGT = pytz.timezone("Asia/Singapore")

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class AttachmentInfo(BaseModel):
    name: str
    gcs_url: str


class TaskResponse(BaseModel):
    id: str
    title: str
    description: str
    project_id: str
    project_name: str
    client_id: str
    client_name: str
    parent_task_id: Optional[str]
    status: str
    priority: str
    due_date: Optional[str]
    attachments: list[AttachmentInfo]
    datetime_inserted: str
    datetime_updated: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_sgt() -> str:
    """Return current datetime as ISO-8601 string in Singapore time (UTC+8)."""
    return datetime.now(tz=SGT).isoformat()


def _doc_to_task(doc) -> TaskResponse:
    data = doc.to_dict()
    attachments = [
        AttachmentInfo(name=a["name"], gcs_url=a["gcs_url"])
        for a in data.get("attachments", [])
    ]
    return TaskResponse(
        id=doc.id,
        title=data.get("title", ""),
        description=data.get("description", ""),
        project_id=data.get("project_id", ""),
        project_name=data.get("project_name", ""),
        client_id=data.get("client_id", ""),
        client_name=data.get("client_name", ""),
        parent_task_id=data.get("parent_task_id"),
        status=data.get("status", "todo"),
        priority=data.get("priority", "medium"),
        due_date=data.get("due_date"),
        attachments=attachments,
        datetime_inserted=data.get("datetime_inserted", ""),
        datetime_updated=data.get("datetime_updated", ""),
    )


def _fetch_project(db, project_id: str) -> dict:
    """
    Fetch a project document from Firestore.

    Returns a dict with keys: project_name, client_id, client_name.
    Raises 404 if the project does not exist.
    """
    doc = db.collection("projects").document(project_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project '{project_id}' not found.",
        )
    data = doc.to_dict()
    return {
        "project_name": data.get("name", ""),
        "client_id": data.get("client_id", ""),
        "client_name": data.get("client_name", ""),
    }


def _blob_name_from_url(gcs_url: str, bucket_name: str) -> str:
    """Extract the blob path from a public GCS URL."""
    prefix = f"https://storage.googleapis.com/{bucket_name}/"
    if gcs_url.startswith(prefix):
        return gcs_url[len(prefix):]
    # Fallback: strip everything up to the bucket name segment
    return gcs_url.split(f"/{bucket_name}/", 1)[-1]


def _sort_tasks(tasks: list[TaskResponse]) -> list[TaskResponse]:
    """
    Sort tasks by due_date ascending (nulls last), then datetime_inserted ascending.
    """
    return sorted(
        tasks,
        key=lambda t: (
            t.due_date is None,        # False (0) sorts before True (1) → nulls last
            t.due_date or "",
            t.datetime_inserted,
        ),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    _user: Annotated[dict, Depends(get_current_user)],
    project_id: Optional[str] = None,
    parent_task_id: Optional[str] = None,
    status: Optional[str] = None,
    priority: Optional[str] = None,
) -> list[TaskResponse]:
    """
    Return tasks with optional filters.

    - ``project_id``     – filter by project.
    - ``parent_task_id`` – filter by parent task; pass the literal string
                           ``"null"`` to retrieve only top-level tasks
                           (where ``parent_task_id`` is ``None``).
    - ``status``         – filter by status (``todo``, ``in_progress``, ``done``).
    - ``priority``       – filter by priority (``low``, ``medium``, ``high``, ``urgent``).

    Results are sorted by ``due_date`` ascending (nulls last), then
    ``datetime_inserted`` ascending.
    """
    db = get_firestore_client()
    query = db.collection("tasks")

    if project_id is not None:
        query = query.where("project_id", "==", project_id)

    if parent_task_id is not None:
        if parent_task_id.lower() == "null":
            query = query.where("parent_task_id", "==", None)
        else:
            query = query.where("parent_task_id", "==", parent_task_id)

    if status is not None:
        query = query.where("status", "==", status)

    if priority is not None:
        query = query.where("priority", "==", priority)

    docs = query.stream()
    tasks = [_doc_to_task(doc) for doc in docs]
    return _sort_tasks(tasks)


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> TaskResponse:
    """Return a single task by its Firestore document ID."""
    db = get_firestore_client()
    doc = db.collection("tasks").document(task_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_id}' not found.",
        )
    return _doc_to_task(doc)


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    _user: Annotated[dict, Depends(get_current_user)],
    title: str = Form(...),
    project_id: str = Form(...),
    description: str = Form(default=""),
    parent_task_id: Optional[str] = Form(default=None),
    status: str = Form(default="todo"),
    priority: str = Form(default="medium"),
    due_date: Optional[str] = Form(default=None),
    attachments: list[UploadFile] = File(default=[]),
) -> TaskResponse:
    """
    Create a new task.

    Accepts ``multipart/form-data`` with:
    - ``title``          – task title.
    - ``project_id``     – ID of an existing project document.
    - ``description``    – (optional) task description, defaults to empty string.
    - ``parent_task_id`` – (optional) ID of a parent task; omit for top-level tasks.
    - ``status``         – (optional) ``todo`` | ``in_progress`` | ``done``, default ``todo``.
    - ``priority``       – (optional) ``low`` | ``medium`` | ``high`` | ``urgent``, default ``medium``.
    - ``due_date``       – (optional) ISO date string ``YYYY-MM-DD``.
    - ``attachments``    – (optional, repeatable) file uploads.

    Denormalised fields ``project_name``, ``client_id``, and ``client_name`` are
    fetched from the project document automatically.  Files are uploaded to GCS
    under ``tasks/<task_id>/<original_filename>``.
    """
    db = get_firestore_client()

    # Fetch project and denormalise fields
    project_data = _fetch_project(db, project_id)

    # Allocate the document ID up-front so we can use it in GCS paths
    doc_ref = db.collection("tasks").document()
    task_id = doc_ref.id

    # Normalise empty string parent_task_id to None
    resolved_parent_task_id: Optional[str] = parent_task_id if parent_task_id else None

    # Upload attachments to GCS
    attachment_records: list[dict] = []
    for upload in attachments:
        if not upload.filename:
            continue
        file_bytes = await upload.read()
        blob_name = f"tasks/{task_id}/{upload.filename}"
        content_type = upload.content_type or "application/octet-stream"
        public_url = upload_file(file_bytes, blob_name, content_type)
        attachment_records.append({"name": upload.filename, "gcs_url": public_url})

    now = _now_sgt()
    task_data = {
        "title": title,
        "description": description,
        "project_id": project_id,
        "project_name": project_data["project_name"],
        "client_id": project_data["client_id"],
        "client_name": project_data["client_name"],
        "parent_task_id": resolved_parent_task_id,
        "status": status,
        "priority": priority,
        "due_date": due_date if due_date else None,
        "attachments": attachment_records,
        "datetime_inserted": now,
        "datetime_updated": now,
    }
    doc_ref.set(task_data)

    doc = doc_ref.get()
    return _doc_to_task(doc)


@router.put("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
    title: Optional[str] = Form(default=None),
    description: Optional[str] = Form(default=None),
    project_id: Optional[str] = Form(default=None),
    parent_task_id: Optional[str] = Form(default=None),
    status: Optional[str] = Form(default=None),
    priority: Optional[str] = Form(default=None),
    due_date: Optional[str] = Form(default=None),
    attachments: list[UploadFile] = File(default=[]),
) -> TaskResponse:
    """
    Update an existing task.

    Accepts ``multipart/form-data``; all fields are optional.

    - When ``project_id`` changes, ``project_name``, ``client_id``, and
      ``client_name`` are refreshed automatically.
    - New attachment files are uploaded to GCS and appended to the existing
      attachment list.
    - ``datetime_updated`` is always refreshed on a successful update.
    """
    db = get_firestore_client()
    doc_ref = db.collection("tasks").document(task_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_id}' not found.",
        )

    existing_data = doc.to_dict()
    updates: dict = {}

    if title is not None:
        updates["title"] = title

    if description is not None:
        updates["description"] = description

    if project_id is not None:
        project_data = _fetch_project(db, project_id)
        updates["project_id"] = project_id
        updates["project_name"] = project_data["project_name"]
        updates["client_id"] = project_data["client_id"]
        updates["client_name"] = project_data["client_name"]

    if parent_task_id is not None:
        # Allow callers to clear parent by passing the literal string "null"
        updates["parent_task_id"] = None if parent_task_id.lower() == "null" else parent_task_id

    if status is not None:
        updates["status"] = status

    if priority is not None:
        updates["priority"] = priority

    if due_date is not None:
        # Allow callers to clear due_date by passing the literal string "null"
        updates["due_date"] = None if due_date.lower() == "null" else due_date

    # Upload new attachments and append to existing list
    new_attachment_records: list[dict] = []
    for upload in attachments:
        if not upload.filename:
            continue
        file_bytes = await upload.read()
        blob_name = f"tasks/{task_id}/{upload.filename}"
        content_type = upload.content_type or "application/octet-stream"
        public_url = upload_file(file_bytes, blob_name, content_type)
        new_attachment_records.append({"name": upload.filename, "gcs_url": public_url})

    if new_attachment_records:
        existing_attachments = existing_data.get("attachments", [])
        updates["attachments"] = existing_attachments + new_attachment_records

    updates["datetime_updated"] = _now_sgt()

    doc_ref.update(updates)
    updated_doc = doc_ref.get()
    return _doc_to_task(updated_doc)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    task_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> None:
    """
    Delete a task and all its GCS attachments.

    GCS blob deletion failures are logged but do not prevent the Firestore
    document from being removed.
    """
    db = get_firestore_client()
    doc_ref = db.collection("tasks").document(task_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_id}' not found.",
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
