from datetime import datetime
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends, status
from pydantic import BaseModel

from auth import get_current_user, owner_id_of
from services.firestore_service import get_firestore_client, get_owned_doc, owned_query

router = APIRouter(prefix="/projects", tags=["projects"])

SGT = pytz.timezone("Asia/Singapore")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class ProjectCreate(BaseModel):
    name: str
    client_id: str
    rate: Optional[float] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    client_id: Optional[str] = None
    rate: Optional[float] = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    client_id: str
    client_name: str
    rate: Optional[float]
    datetime_inserted: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_sgt() -> str:
    """Return current datetime as ISO-8601 string in Singapore time (UTC+8)."""
    return datetime.now(tz=SGT).isoformat()


def _doc_to_project(doc) -> ProjectResponse:
    data = doc.to_dict()
    return ProjectResponse(
        id=doc.id,
        name=data.get("name", ""),
        client_id=data.get("client_id", ""),
        client_name=data.get("client_name", ""),
        rate=data.get("rate"),
        datetime_inserted=data.get("datetime_inserted", ""),
    )


def _fetch_client_name(db, client_id: str, owner_id: str) -> str:
    """Fetch the caller's client name. Raises 404 if missing or not theirs."""
    doc = get_owned_doc(db, "clients", client_id, owner_id, "Client")
    return (doc.to_dict() or {}).get("name", "")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    _user: Annotated[dict, Depends(get_current_user)],
    client_id: Optional[str] = None,
) -> list[ProjectResponse]:
    """Return the caller's projects, optionally filtered by client_id, sorted by name."""
    db = get_firestore_client()
    query = owned_query(db, "projects", owner_id_of(_user))

    # Apply the equality filters in Firestore and sort in Python, rather than
    # combining where() with order_by() — that pairing needs a composite index.
    if client_id is not None:
        query = query.where("client_id", "==", client_id)
    docs = list(query.stream())
    docs.sort(key=lambda d: (d.to_dict() or {}).get("name", ""))

    return [_doc_to_project(doc) for doc in docs]


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ProjectResponse:
    """Return a single project by its Firestore document ID."""
    db = get_firestore_client()
    doc = get_owned_doc(db, "projects", project_id, owner_id_of(_user), "Project")
    return _doc_to_project(doc)


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ProjectResponse:
    """
    Create a new project.

    Fetches ``client_name`` from Firestore using the provided ``client_id`` and
    stores it as a denormalised field on the project document.

    ``rate`` is an optional hourly rate that overrides the client default when
    an invoice line is built.
    """
    owner_id = owner_id_of(_user)
    db = get_firestore_client()
    client_name = _fetch_client_name(db, payload.client_id, owner_id)

    _, doc_ref = db.collection("projects").add(
        {
            "owner_id": owner_id,
            "name": payload.name,
            "client_id": payload.client_id,
            "client_name": client_name,
            "rate": payload.rate,
            "datetime_inserted": _now_sgt(),
        }
    )
    doc = doc_ref.get()
    return _doc_to_project(doc)


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    payload: ProjectUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ProjectResponse:
    """
    Update an existing project's name, client_id, and/or rate.

    When ``client_id`` changes, ``client_name`` is refreshed automatically.
    Only fields that are explicitly provided are updated. Pass ``rate=null`` to
    clear the project rate so it falls back to the client default; omitting it
    leaves the rate unchanged.
    """
    owner_id = owner_id_of(_user)
    db = get_firestore_client()
    doc = get_owned_doc(db, "projects", project_id, owner_id, "Project")
    doc_ref = doc.reference

    updates: dict = {}

    if payload.name is not None:
        updates["name"] = payload.name

    if payload.client_id is not None:
        client_name = _fetch_client_name(db, payload.client_id, owner_id)
        updates["client_id"] = payload.client_id
        updates["client_name"] = client_name

    # Nullable numeric: presence in the payload, not non-None-ness, decides
    # whether to write — so an explicit null clears the rate.
    if "rate" in payload.model_fields_set:
        updates["rate"] = payload.rate

    if updates:
        doc_ref.update(updates)

    updated_doc = doc_ref.get()
    return _doc_to_project(updated_doc)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> None:
    """Delete a project entry. Does not cascade to related tasks."""
    db = get_firestore_client()
    doc = get_owned_doc(db, "projects", project_id, owner_id_of(_user), "Project")
    doc.reference.delete()
