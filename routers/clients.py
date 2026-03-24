from datetime import datetime
from typing import Annotated

import pytz
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from auth import get_current_user
from services.firestore_service import get_firestore_client

router = APIRouter(prefix="/clients", tags=["clients"])

SGT = pytz.timezone("Asia/Singapore")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class ClientCreate(BaseModel):
    name: str


class ClientUpdate(BaseModel):
    name: str


class ClientResponse(BaseModel):
    id: str
    name: str
    datetime_inserted: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_sgt() -> str:
    """Return current datetime as ISO-8601 string in Singapore time (UTC+8)."""
    return datetime.now(tz=SGT).isoformat()


def _doc_to_client(doc) -> ClientResponse:
    data = doc.to_dict()
    return ClientResponse(
        id=doc.id,
        name=data.get("name", ""),
        datetime_inserted=data.get("datetime_inserted", ""),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[ClientResponse])
async def list_clients(
    _user: Annotated[dict, Depends(get_current_user)],
) -> list[ClientResponse]:
    """Return all clients sorted by name ascending."""
    db = get_firestore_client()
    docs = db.collection("clients").order_by("name").stream()
    return [_doc_to_client(doc) for doc in docs]


@router.get("/{client_id}", response_model=ClientResponse)
async def get_client(
    client_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ClientResponse:
    """Return a single client by its Firestore document ID."""
    db = get_firestore_client()
    doc = db.collection("clients").document(client_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Client '{client_id}' not found.",
        )
    return _doc_to_client(doc)


@router.post("", response_model=ClientResponse, status_code=status.HTTP_201_CREATED)
async def create_client(
    payload: ClientCreate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ClientResponse:
    """Create a new client entry."""
    db = get_firestore_client()
    _, doc_ref = db.collection("clients").add(
        {
            "name": payload.name,
            "datetime_inserted": _now_sgt(),
        }
    )
    doc = doc_ref.get()
    return _doc_to_client(doc)


@router.put("/{client_id}", response_model=ClientResponse)
async def update_client(
    client_id: str,
    payload: ClientUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ClientResponse:
    """Update the name of an existing client."""
    db = get_firestore_client()
    doc_ref = db.collection("clients").document(client_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Client '{client_id}' not found.",
        )
    doc_ref.update({"name": payload.name})
    updated_doc = doc_ref.get()
    return _doc_to_client(updated_doc)


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(
    client_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> None:
    """Delete a client entry. Does not cascade to related projects or tasks."""
    db = get_firestore_client()
    doc_ref = db.collection("clients").document(client_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Client '{client_id}' not found.",
        )
    doc_ref.delete()
