from datetime import datetime
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth import get_current_user
from services.firestore_service import get_firestore_client

router = APIRouter(prefix="/settings", tags=["settings"])

SGT = pytz.timezone("Asia/Singapore")

# The singleton document holding issuer details and invoice defaults.
SETTINGS_DOC_ID = "invoice"

DEFAULT_SETTINGS: dict = {
    "business_name": "",
    "address": "",
    "email": "",
    "logo_url": None,
    "default_currency": "SGD",
    "default_payment_terms": "Net 14",
    "default_due_days": 14,
    "default_tax_label": "GST",
    "default_tax_percent": 0.0,
    "default_rate": 0.0,
    "invoice_prefix": "INV",
    "reset_sequence_yearly": True,
}

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class InvoiceSettingsUpdate(BaseModel):
    business_name: Optional[str] = None
    address: Optional[str] = None
    email: Optional[str] = None
    logo_url: Optional[str] = None
    default_currency: Optional[str] = None
    default_payment_terms: Optional[str] = None
    default_due_days: Optional[int] = None
    default_tax_label: Optional[str] = None
    default_tax_percent: Optional[float] = None
    default_rate: Optional[float] = None
    invoice_prefix: Optional[str] = None
    reset_sequence_yearly: Optional[bool] = None


class InvoiceSettingsResponse(BaseModel):
    business_name: str
    address: str
    email: str
    logo_url: Optional[str]
    default_currency: str
    default_payment_terms: str
    default_due_days: int
    default_tax_label: str
    default_tax_percent: float
    default_rate: float
    invoice_prefix: str
    reset_sequence_yearly: bool
    datetime_inserted: str
    datetime_updated: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_sgt() -> str:
    """Return current datetime as ISO-8601 string in Singapore time (UTC+8)."""
    return datetime.now(tz=SGT).isoformat()


def _data_to_settings(data: dict) -> InvoiceSettingsResponse:
    return InvoiceSettingsResponse(
        business_name=data.get("business_name", DEFAULT_SETTINGS["business_name"]),
        address=data.get("address", DEFAULT_SETTINGS["address"]),
        email=data.get("email", DEFAULT_SETTINGS["email"]),
        logo_url=data.get("logo_url", DEFAULT_SETTINGS["logo_url"]),
        default_currency=data.get(
            "default_currency", DEFAULT_SETTINGS["default_currency"]
        ),
        default_payment_terms=data.get(
            "default_payment_terms", DEFAULT_SETTINGS["default_payment_terms"]
        ),
        default_due_days=data.get(
            "default_due_days", DEFAULT_SETTINGS["default_due_days"]
        ),
        default_tax_label=data.get(
            "default_tax_label", DEFAULT_SETTINGS["default_tax_label"]
        ),
        default_tax_percent=data.get(
            "default_tax_percent", DEFAULT_SETTINGS["default_tax_percent"]
        ),
        default_rate=data.get("default_rate", DEFAULT_SETTINGS["default_rate"]),
        invoice_prefix=data.get("invoice_prefix", DEFAULT_SETTINGS["invoice_prefix"]),
        reset_sequence_yearly=data.get(
            "reset_sequence_yearly", DEFAULT_SETTINGS["reset_sequence_yearly"]
        ),
        datetime_inserted=data.get("datetime_inserted", ""),
        datetime_updated=data.get("datetime_updated", ""),
    )


def get_invoice_settings(db) -> dict:
    """
    Return the invoice settings document, creating it with defaults if absent.

    Shared with the invoice router, which needs the issuer snapshot and the
    numbering defaults without going through the HTTP layer.

    Args:
        db: Firestore client.

    Returns:
        The raw settings dict.
    """
    doc_ref = db.collection("settings").document(SETTINGS_DOC_ID)
    doc = doc_ref.get()
    if doc.exists:
        return doc.to_dict() or {}

    now = _now_sgt()
    data = {
        **DEFAULT_SETTINGS,
        "datetime_inserted": now,
        "datetime_updated": now,
    }
    doc_ref.set(data)
    return data


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/invoice", response_model=InvoiceSettingsResponse)
async def get_settings(
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoiceSettingsResponse:
    """
    Return the invoice settings singleton.

    The document is created with defaults on first read, so this never 404s.
    """
    db = get_firestore_client()
    return _data_to_settings(get_invoice_settings(db))


@router.put("/invoice", response_model=InvoiceSettingsResponse)
async def update_settings(
    payload: InvoiceSettingsUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> InvoiceSettingsResponse:
    """
    Update the invoice settings singleton.

    - Creates the document with defaults first if it does not exist yet.
    - Pass ``logo_url="null"`` to clear the logo.
    - Only fields present in the payload are updated.

    Changing these defaults never rewrites existing invoices — issuer details
    and rates are snapshotted onto each invoice at creation.
    """
    db = get_firestore_client()
    doc_ref = db.collection("settings").document(SETTINGS_DOC_ID)
    get_invoice_settings(db)  # Ensure the document exists before updating.

    updates: dict = {}

    for field in (
        "business_name",
        "address",
        "email",
        "default_currency",
        "default_payment_terms",
        "default_due_days",
        "default_tax_label",
        "default_tax_percent",
        "default_rate",
        "invoice_prefix",
        "reset_sequence_yearly",
    ):
        value = getattr(payload, field)
        if value is not None:
            updates[field] = value

    if payload.logo_url is not None:
        updates["logo_url"] = (
            None if payload.logo_url.lower() == "null" else payload.logo_url
        )

    if updates:
        updates["datetime_updated"] = _now_sgt()
        doc_ref.update(updates)

    updated_doc = doc_ref.get()
    return _data_to_settings(updated_doc.to_dict() or {})
