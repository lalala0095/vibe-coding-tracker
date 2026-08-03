from datetime import datetime
from typing import Annotated, Optional

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
    default_rate: Optional[float] = None
    currency: str = "SGD"
    billing_email: Optional[str] = None
    billing_address: Optional[str] = None


class ClientUpdate(BaseModel):
    name: Optional[str] = None
    default_rate: Optional[float] = None
    currency: Optional[str] = None
    billing_email: Optional[str] = None
    billing_address: Optional[str] = None


class ClientResponse(BaseModel):
    id: str
    name: str
    default_rate: Optional[float]
    currency: str
    billing_email: Optional[str]
    billing_address: Optional[str]
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
        default_rate=data.get("default_rate"),
        currency=data.get("currency", "SGD"),
        billing_email=data.get("billing_email"),
        billing_address=data.get("billing_address"),
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
    """
    Create a new client entry.

    - ``name``            – client name (required).
    - ``default_rate``    – (optional) fallback hourly rate for invoicing.
    - ``currency``        – currency label for the client, defaults to ``"SGD"``.
    - ``billing_email``   – (optional) email used for billing.
    - ``billing_address`` – (optional) multi-line address used in invoice Bill-To.
    """
    db = get_firestore_client()
    _, doc_ref = db.collection("clients").add(
        {
            "name": payload.name,
            "default_rate": payload.default_rate,
            "currency": payload.currency,
            "billing_email": payload.billing_email,
            "billing_address": payload.billing_address,
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
    """
    Update an existing client.

    - Pass ``billing_email="null"`` or ``billing_address="null"`` to clear those
      fields.
    - Pass ``default_rate=null`` to clear the rate; omitting it leaves it
      unchanged.
    - Only fields present in the payload are updated.
    """
    db = get_firestore_client()
    doc_ref = db.collection("clients").document(client_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Client '{client_id}' not found.",
        )

    updates: dict = {}

    if payload.name is not None:
        updates["name"] = payload.name

    # Nullable numeric: presence in the payload, not non-None-ness, decides
    # whether to write — so an explicit null clears the rate.
    if "default_rate" in payload.model_fields_set:
        updates["default_rate"] = payload.default_rate

    if payload.currency is not None:
        updates["currency"] = payload.currency

    if payload.billing_email is not None:
        updates["billing_email"] = (
            None if payload.billing_email.lower() == "null" else payload.billing_email
        )

    if payload.billing_address is not None:
        updates["billing_address"] = (
            None
            if payload.billing_address.lower() == "null"
            else payload.billing_address
        )

    if updates:
        doc_ref.update(updates)

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
