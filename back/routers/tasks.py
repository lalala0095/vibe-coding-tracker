import json
import logging
from datetime import datetime
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi import status as http_status  # update_task shadows ``status`` with a form field
from pydantic import BaseModel

from auth import get_current_user, owner_id_of
from services.firestore_service import get_firestore_client, get_owned_doc, owned_query
from services.storage_service import (
    delete_attachments,
    owned_blob_name,
    signed_attachments,
    upload_file,
)

router = APIRouter(prefix="/tasks", tags=["tasks"])

SGT = pytz.timezone("Asia/Singapore")

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class AttachmentInfo(BaseModel):
    name: str
    # A short-lived signed URL (the bucket is private), minted on every read.
    # ``None`` when it could not be signed.  Never stored.
    gcs_url: Optional[str] = None


class TaskBulkCreate(BaseModel):
    """
    Several tasks created in one call, from a pasted list of titles.

    JSON rather than multipart because bulk-created tasks carry no
    attachments — the single-task endpoint stays the one that handles uploads.

    Send ``project_ids`` (ordered, first = primary).  The legacy scalar
    ``project_id`` is still accepted and means ``[project_id]``; when both are
    sent ``project_ids`` wins.
    """

    project_id: Optional[str] = None
    project_ids: Optional[list[str]] = None
    titles: list[str]
    parent_task_id: Optional[str] = None
    status: str = "todo"
    priority: str = "medium"
    due_date: Optional[str] = None


class TaskProjectInfo(BaseModel):
    """One of a task's projects, with its denormalised names."""

    project_id: str
    project_name: str
    client_id: str
    client_name: str


class TaskResponse(BaseModel):
    """
    A task.  ``project_ids`` is ordered and non-empty for any well-formed task;
    index 0 is the PRIMARY project.  ``projects`` is the same list with names,
    ``client_ids`` the distinct clients in first-seen order.  The scalar
    ``project_id``/``project_name``/``client_id``/``client_name`` are kept for
    older clients and always mirror ``projects[0]``.
    """

    id: str
    title: str
    description: str
    project_ids: list[str]
    projects: list[TaskProjectInfo]
    client_ids: list[str]
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


def task_projects(data: dict) -> list[dict]:
    """
    Return a task document's projects as ``[{project_id, project_name,
    client_id, client_name}, ...]``, primary first.

    The one place that reads the multi-project fields, so every router agrees
    on the rule for older documents:

    - ``projects`` (the denormalised array) is used when present;
    - else ``project_ids`` alone, with names taken from the legacy scalars for
      the id they describe and left empty for the rest;
    - else a legacy document with only the scalar ``project_id`` reads as a
      one-project list;
    - a document with no project at all reads as ``[]`` — never an error.
    """
    scalar = {
        "project_id": data.get("project_id") or "",
        "project_name": data.get("project_name") or "",
        "client_id": data.get("client_id") or "",
        "client_name": data.get("client_name") or "",
    }

    stored = data.get("projects") or []
    ids = [pid for pid in (data.get("project_ids") or []) if pid]
    by_id: dict = {}
    for entry in stored:
        if isinstance(entry, dict) and entry.get("project_id"):
            by_id.setdefault(entry["project_id"], entry)
    if not ids:
        ids = list(by_id)
    if not ids and scalar["project_id"]:
        ids = [scalar["project_id"]]

    result: list[dict] = []
    for pid in dict.fromkeys(ids):
        entry = by_id.get(pid)
        if entry is None and pid == scalar["project_id"]:
            entry = scalar
        entry = entry or {}
        result.append(
            {
                "project_id": pid,
                "project_name": entry.get("project_name") or "",
                "client_id": entry.get("client_id") or "",
                "client_name": entry.get("client_name") or "",
            }
        )
    return result


def task_project_ids(data: dict) -> list[str]:
    """Ordered project ids of a task document (index 0 = primary)."""
    return [p["project_id"] for p in task_projects(data)]


def task_client_ids(data: dict) -> list[str]:
    """Distinct client ids of a task document's projects, first-seen order."""
    return list(
        dict.fromkeys(p["client_id"] for p in task_projects(data) if p["client_id"])
    )


def task_primary_project(data: dict) -> dict:
    """
    The task's primary project entry (``projects[0]``), or an all-empty entry.

    Tracker pricing and ``POST /trackers/{id}/bill`` use this — a tracker span
    has no per-entry project choice, so it bills under the primary.
    """
    projects = task_projects(data)
    if projects:
        return projects[0]
    return {"project_id": "", "project_name": "", "client_id": "", "client_name": ""}


def _doc_to_task(doc) -> TaskResponse:
    data = doc.to_dict() or {}
    attachments = [
        AttachmentInfo(**a)
        for a in signed_attachments(
            data.get("attachments", []), data.get("owner_id"), "tasks", doc.id
        )
    ]
    projects = task_projects(data)
    primary = task_primary_project(data)
    return TaskResponse(
        id=doc.id,
        title=data.get("title", ""),
        description=data.get("description", ""),
        project_ids=[p["project_id"] for p in projects],
        projects=[TaskProjectInfo(**p) for p in projects],
        client_ids=task_client_ids(data),
        project_id=primary["project_id"],
        project_name=primary["project_name"],
        client_id=primary["client_id"],
        client_name=primary["client_name"],
        parent_task_id=data.get("parent_task_id"),
        status=data.get("status", "todo"),
        priority=data.get("priority", "medium"),
        due_date=data.get("due_date"),
        attachments=attachments,
        datetime_inserted=data.get("datetime_inserted", ""),
        datetime_updated=data.get("datetime_updated", ""),
    )


def _fetch_project(db, project_id: str, owner_id: str) -> dict:
    """
    Fetch one of the caller's project documents from Firestore.

    Returns a dict with keys: project_name, client_id, client_name.
    Raises 404 if the project does not exist or belongs to someone else.
    """
    doc = get_owned_doc(db, "projects", project_id, owner_id, "Project")
    data = doc.to_dict() or {}
    return {
        "project_name": data.get("name", ""),
        "client_id": data.get("client_id", ""),
        "client_name": data.get("client_name", ""),
    }


def _clean_project_ids(project_ids) -> list[str]:
    """Strip, drop blanks and de-duplicate, keeping the first occurrence."""
    cleaned = [str(pid).strip() for pid in (project_ids or [])]
    return list(dict.fromkeys(pid for pid in cleaned if pid))


def _parse_form_project_ids(values: Optional[list[str]]) -> Optional[list[str]]:
    """
    Read ``project_ids`` from a multipart form.

    Two encodings are accepted, so neither client has to fight its FormData:

    - the field repeated once per id (``project_ids=a``, ``project_ids=b``);
    - one field holding a JSON array string (``project_ids=["a","b"]``).

    Returns None when the field was not sent at all.
    """
    if values is None:
        return None
    ids: list[str] = []
    for value in values:
        text = (value or "").strip()
        if text.startswith("["):
            try:
                parsed = json.loads(text)
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Field 'project_ids' is not a valid JSON array.",
                )
            if not isinstance(parsed, list):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Field 'project_ids' is not a valid JSON array.",
                )
            ids.extend(str(item) for item in parsed if item is not None)
        else:
            ids.append(text)
    return _clean_project_ids(ids)


def _require_project_ids(project_ids: Optional[list[str]], project_id: Optional[str]) -> list[str]:
    """
    Resolve a create request's projects: a non-empty ``project_ids`` wins, else
    the legacy scalar ``project_id`` means ``[project_id]``.  At least one is
    required (400).
    """
    ids = _clean_project_ids(project_ids)
    if not ids and project_id and project_id.strip():
        ids = [project_id.strip()]
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A task needs at least one project: send 'project_ids'.",
        )
    return ids


def _validate_parent_task(db, parent_task_id: Optional[str], owner_id: str) -> None:
    """404 unless ``parent_task_id`` (when set) is one of the caller's tasks."""
    if parent_task_id:
        get_owned_doc(db, "tasks", parent_task_id, owner_id, "Task")


def build_project_fields(db, project_ids: list[str], owner_id: str) -> dict:
    """
    Fetch every project (404 on the first one that is missing or not the
    caller's) and return the stored
    task fields: ``project_ids``, ``projects``, ``client_ids`` and the legacy
    scalars mirrored from the primary (index 0).
    """
    projects = []
    for pid in project_ids:
        project_data = _fetch_project(db, pid, owner_id)
        projects.append({"project_id": pid, **project_data})
    primary = projects[0]
    return {
        "project_ids": [p["project_id"] for p in projects],
        "projects": projects,
        "client_ids": list(
            dict.fromkeys(p["client_id"] for p in projects if p["client_id"])
        ),
        "project_id": primary["project_id"],
        "project_name": primary["project_name"],
        "client_id": primary["client_id"],
        "client_name": primary["client_name"],
    }


def _check_removed_projects_unused(
    db, task_id: str, owner_id: str, current: list[dict], new_ids: list[str]
) -> None:
    """
    Refuse (409) to unlink a project that time entries of this task still use.

    Referential integrity, not a field lock: every time entry must point at one
    of its task's projects.  Only projects actually being removed are checked,
    so an entry already pointing somewhere odd never blocks an unrelated edit.
    """
    removed = [p for p in current if p["project_id"] not in set(new_ids)]
    if not removed:
        return
    counts: dict = {}
    sessions = owned_query(db, "sessions", owner_id).where("task_id", "==", task_id)
    for doc in sessions.stream():
        pid = (doc.to_dict() or {}).get("project_id")
        if pid:
            counts[pid] = counts.get(pid, 0) + 1
    problems = []
    for project in removed:
        count = counts.get(project["project_id"], 0)
        if count:
            noun = "time entry" if count == 1 else "time entries"
            verb = "uses" if count == 1 else "use"
            name = project["project_name"] or project["project_id"]
            problems.append(f"{count} {noun} on this task {verb} {name}")
    if problems:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="; ".join(problems) + " — move them to another project first.",
        )


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

    - ``project_id``     – tasks linked to this project, i.e. whose
                           ``project_ids`` contains it (primary or not).
    - ``parent_task_id`` – filter by parent task; pass the literal string
                           ``"null"`` to retrieve only top-level tasks
                           (where ``parent_task_id`` is ``None``).
    - ``status``         – filter by status (``todo``, ``in_progress``, ``done``).
    - ``priority``       – filter by priority (``low``, ``medium``, ``high``, ``urgent``).

    Results are sorted by ``due_date`` ascending (nulls last), then
    ``datetime_inserted`` ascending.
    """
    db = get_firestore_client()
    # Only equality filters go to Firestore (served by merging single-field
    # indexes, so no composite index is needed); project membership is checked
    # in Python below.
    query = owned_query(db, "tasks", owner_id_of(_user))

    if parent_task_id is not None:
        if parent_task_id.lower() == "null":
            query = query.where("parent_task_id", "==", None)
        else:
            query = query.where("parent_task_id", "==", parent_task_id)

    if status is not None:
        query = query.where("status", "==", status)

    if priority is not None:
        query = query.where("priority", "==", priority)

    docs = list(query.stream())
    if project_id is not None:
        # Membership in Python rather than ``array_contains``: combined with
        # the owner equality filter that is not guaranteed to be servable
        # without a composite index.  ``task_project_ids`` reads ``project_ids``
        # and falls back to the legacy scalar, so a task written before
        # ``scripts/backfill_task_projects.py`` still matches.
        docs = [
            doc for doc in docs
            if project_id in task_project_ids(doc.to_dict() or {})
        ]

    tasks = [_doc_to_task(doc) for doc in docs]
    return _sort_tasks(tasks)


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> TaskResponse:
    """Return a single task by its Firestore document ID."""
    db = get_firestore_client()
    doc = get_owned_doc(db, "tasks", task_id, owner_id_of(_user), "Task")
    return _doc_to_task(doc)


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    _user: Annotated[dict, Depends(get_current_user)],
    title: str = Form(...),
    project_id: Optional[str] = Form(default=None),
    project_ids: Optional[list[str]] = Form(default=None),
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
    - ``project_ids``    – ordered ids of existing projects, first = primary.
                           Either repeat the field once per id
                           (``project_ids=p1``, ``project_ids=p2``) or send one
                           field holding a JSON array (``project_ids=["p1","p2"]``).
                           Blanks and duplicates are dropped.
    - ``project_id``     – legacy: a single project, used only when
                           ``project_ids`` is absent or empty.  One of the two
                           is required (400), every id must exist (404).
    - ``description``    – (optional) task description, defaults to empty string.
    - ``parent_task_id`` – (optional) ID of a parent task; omit for top-level tasks.
    - ``status``         – (optional) ``todo`` | ``in_progress`` | ``done``, default ``todo``.
    - ``priority``       – (optional) ``low`` | ``medium`` | ``high`` | ``urgent``, default ``medium``.
    - ``due_date``       – (optional) ISO date string ``YYYY-MM-DD``.
    - ``attachments``    – (optional, repeatable) file uploads.

    ``projects`` (names per project), ``client_ids`` and the legacy scalars
    ``project_name``/``client_id``/``client_name`` (mirroring the primary) are
    fetched from the project documents automatically.  Files are uploaded to GCS
    under ``<owner_id>/tasks/<task_id>/<original_filename>``.
    """
    owner_id = owner_id_of(_user)
    db = get_firestore_client()

    # Fetch the projects and denormalise their fields
    project_fields = build_project_fields(
        db,
        _require_project_ids(_parse_form_project_ids(project_ids), project_id),
        owner_id,
    )

    # Allocate the document ID up-front so we can use it in GCS paths
    doc_ref = db.collection("tasks").document()
    task_id = doc_ref.id

    # Normalise empty string parent_task_id to None
    resolved_parent_task_id: Optional[str] = parent_task_id if parent_task_id else None
    _validate_parent_task(db, resolved_parent_task_id, owner_id)

    # Upload attachments to GCS
    attachment_records: list[dict] = []
    for upload in attachments:
        if not upload.filename:
            continue
        file_bytes = await upload.read()
        blob_name = owned_blob_name(owner_id, "tasks", task_id, upload.filename)
        content_type = upload.content_type or "application/octet-stream"
        upload_file(file_bytes, blob_name, content_type)
        attachment_records.append({"name": upload.filename, "blob_name": blob_name})

    now = _now_sgt()
    task_data = {
        "owner_id": owner_id,
        "title": title,
        "description": description,
        **project_fields,
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


@router.post(
    "/bulk", response_model=list[TaskResponse], status_code=status.HTTP_201_CREATED
)
async def create_tasks_bulk(
    payload: TaskBulkCreate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> list[TaskResponse]:
    """
    Create several tasks under one project in a single call.

    Built for pasting a list of task titles — from a spreadsheet, a plan
    document, or a chat message — instead of filling the form once per task.

    - ``titles``         – one task per entry.  Blank and duplicate titles are
      dropped, and the surviving order is preserved.
    - ``project_ids``    – ordered ids of existing projects, first = primary.
    - ``project_id``     – legacy single project, used when ``project_ids`` is
      absent or empty.  One of the two is required (400).
    - ``parent_task_id`` – (optional) nest every created task under this one.
    - ``status`` / ``priority`` / ``due_date`` – applied to all of them.

    Returns the created tasks in the order they were given.
    """
    owner_id = owner_id_of(_user)
    db = get_firestore_client()
    project_fields = build_project_fields(
        db, _require_project_ids(payload.project_ids, payload.project_id), owner_id
    )
    _validate_parent_task(db, payload.parent_task_id, owner_id)

    titles: list[str] = []
    seen: set[str] = set()
    for raw in payload.titles:
        title = (raw or "").strip()
        if not title or title in seen:
            continue
        titles.append(title)
        seen.add(title)

    if not titles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Field 'titles' must contain at least one non-empty title.",
        )

    now = _now_sgt()
    # Firestore caps a batch at 500 writes; a pasted list never gets near it,
    # but chunking keeps that true whatever gets pasted.
    doc_refs = [db.collection("tasks").document() for _ in titles]
    for start in range(0, len(titles), 400):
        batch = db.batch()
        for doc_ref, title in zip(
            doc_refs[start : start + 400], titles[start : start + 400]
        ):
            batch.set(
                doc_ref,
                {
                    "owner_id": owner_id,
                    "title": title,
                    "description": "",
                    **project_fields,
                    "parent_task_id": payload.parent_task_id or None,
                    "status": payload.status,
                    "priority": payload.priority,
                    "due_date": payload.due_date or None,
                    "attachments": [],
                    "datetime_inserted": now,
                    "datetime_updated": now,
                },
            )
        batch.commit()

    return [_doc_to_task(doc_ref.get()) for doc_ref in doc_refs]


@router.put("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
    title: Optional[str] = Form(default=None),
    description: Optional[str] = Form(default=None),
    project_id: Optional[str] = Form(default=None),
    project_ids: Optional[list[str]] = Form(default=None),
    parent_task_id: Optional[str] = Form(default=None),
    status: Optional[str] = Form(default=None),
    priority: Optional[str] = Form(default=None),
    due_date: Optional[str] = Form(default=None),
    attachments: list[UploadFile] = File(default=[]),
) -> TaskResponse:
    """
    Update an existing task.

    Accepts ``multipart/form-data``; all fields are optional.

    - ``project_ids`` (same two encodings as create) replaces the whole list;
      order matters, first = primary.  An empty list is a 400.
    - Legacy ``project_id`` alone: already one of the task's projects → no
      change; otherwise it replaces the primary (index 0) and the other
      projects stay.  Ignored when ``project_ids`` is sent.
    - Whenever the projects are written, every project is re-read, so
      ``projects``, ``client_ids`` and the legacy scalars are refreshed.
    - Unlinking a project that time entries of this task still use is a 409
      naming the project and the entry count — move those entries first.
    - New attachment files are uploaded to GCS and appended to the existing
      attachment list.
    - ``datetime_updated`` is always refreshed on a successful update.
    """
    owner_id = owner_id_of(_user)
    db = get_firestore_client()
    doc = get_owned_doc(db, "tasks", task_id, owner_id, "Task")
    doc_ref = doc.reference

    existing_data = doc.to_dict() or {}
    updates: dict = {}

    if title is not None:
        updates["title"] = title

    if description is not None:
        updates["description"] = description

    current_projects = task_projects(existing_data)
    current_ids = [p["project_id"] for p in current_projects]
    new_project_ids: Optional[list[str]] = None
    parsed_ids = _parse_form_project_ids(project_ids)
    if parsed_ids is not None:
        if not parsed_ids:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="Field 'project_ids' must contain at least one project.",
            )
        new_project_ids = parsed_ids
    elif project_id is not None and project_id.strip():
        legacy_id = project_id.strip()
        if legacy_id not in current_ids:
            new_project_ids = [legacy_id] + [
                pid for pid in current_ids[1:] if pid != legacy_id
            ]

    if new_project_ids is not None:
        project_fields = build_project_fields(db, new_project_ids, owner_id)
        _check_removed_projects_unused(
            db, task_id, owner_id, current_projects, new_project_ids
        )
        updates.update(project_fields)

    if parent_task_id is not None:
        # Allow callers to clear parent by passing the literal string "null"
        if parent_task_id.lower() == "null":
            updates["parent_task_id"] = None
        else:
            _validate_parent_task(db, parent_task_id, owner_id)
            updates["parent_task_id"] = parent_task_id

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
        blob_name = owned_blob_name(owner_id, "tasks", task_id, upload.filename)
        content_type = upload.content_type or "application/octet-stream"
        upload_file(file_bytes, blob_name, content_type)
        new_attachment_records.append({"name": upload.filename, "blob_name": blob_name})

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
    owner_id = owner_id_of(_user)
    doc = get_owned_doc(db, "tasks", task_id, owner_id, "Task")
    doc_ref = doc.reference

    data = doc.to_dict() or {}
    delete_attachments(data.get("attachments", []), owner_id, "tasks", task_id)

    # Delete Firestore document
    doc_ref.delete()
