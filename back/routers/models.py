from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from auth import get_current_user
from services.firestore_service import get_firestore_client

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
    return ModelResponse(id=doc.id, name=data["name"])


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[ModelResponse])
async def list_models(
    _user: Annotated[dict, Depends(get_current_user)],
) -> list[ModelResponse]:
    """Return all AI models, ordered by name."""
    db = get_firestore_client()
    docs = db.collection("models").order_by("name").stream()
    return [_doc_to_model(doc) for doc in docs]


@router.get("/{model_id}", response_model=ModelResponse)
async def get_model(
    model_id: str,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ModelResponse:
    """Return a single model by its Firestore document ID."""
    db = get_firestore_client()
    doc = db.collection("models").document(model_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Model '{model_id}' not found.",
        )
    return _doc_to_model(doc)


@router.post("", response_model=ModelResponse, status_code=status.HTTP_201_CREATED)
async def create_model(
    payload: ModelCreate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ModelResponse:
    """Create a new AI model entry."""
    db = get_firestore_client()
    _, doc_ref = db.collection("models").add({"name": payload.name})
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
    doc_ref = db.collection("models").document(model_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Model '{model_id}' not found.",
        )
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
    doc_ref = db.collection("models").document(model_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Model '{model_id}' not found.",
        )
    doc_ref.delete()
