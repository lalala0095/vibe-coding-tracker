from typing import Annotated, Optional

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel

from auth import get_current_user, owner_id_of
from services.firestore_service import get_firestore_client, get_owned_doc, owned_query

router = APIRouter(prefix="/models", tags=["models"])

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class ModelCreate(BaseModel):
    name: str


class ModelUpdate(BaseModel):
    name: str


class ModelResponse(BaseModel):
    id: str
    name: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _doc_to_model(doc) -> ModelResponse:
    data = doc.to_dict()
    return ModelResponse(id=doc.id, name=data.get("name", ""))


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[ModelResponse])
async def list_models(
    _user: Annotated[dict, Depends(get_current_user)],
) -> list[ModelResponse]:
    """Return the caller's AI models, ordered by name."""
    db = get_firestore_client()
    # Sorted in Python: owner_id == plus order_by("name") needs a composite index.
    docs = list(owned_query(db, "models", owner_id_of(_user)).stream())
    docs.sort(key=lambda d: (d.to_dict() or {}).get("name", ""))
    return [_doc_to_model(doc) for doc in docs]


@router.get("/{model_id}", response_model=ModelResponse)
async def get_model(
    model_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ModelResponse:
    """Return a single model by its Firestore document ID."""
    db = get_firestore_client()
    doc = get_owned_doc(db, "models", model_id, owner_id_of(_user), "Model")
    return _doc_to_model(doc)


@router.post("", response_model=ModelResponse, status_code=status.HTTP_201_CREATED)
async def create_model(
    payload: ModelCreate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ModelResponse:
    """Create a new AI model entry."""
    db = get_firestore_client()
    _, doc_ref = db.collection("models").add(
        {"owner_id": owner_id_of(_user), "name": payload.name}
    )
    doc = doc_ref.get()
    return _doc_to_model(doc)


@router.put("/{model_id}", response_model=ModelResponse)
async def update_model(
    model_id: str,
    payload: ModelUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ModelResponse:
    """Update the name of an existing model."""
    db = get_firestore_client()
    doc = get_owned_doc(db, "models", model_id, owner_id_of(_user), "Model")
    doc_ref = doc.reference
    doc_ref.update({"name": payload.name})
    updated_doc = doc_ref.get()
    return _doc_to_model(updated_doc)


@router.delete("/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_model(
    model_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> None:
    """Delete an AI model entry."""
    db = get_firestore_client()
    doc = get_owned_doc(db, "models", model_id, owner_id_of(_user), "Model")
    doc_ref = doc.reference
    doc_ref.delete()
