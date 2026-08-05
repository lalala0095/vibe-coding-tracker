import math
from datetime import datetime
from typing import Annotated, Optional

import pytz
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from auth import get_current_user
from services.firestore_service import get_firestore_client

router = APIRouter(prefix="/settings", tags=["settings"])

SGT = pytz.timezone("Asia/Singapore")

# The singleton document holding issuer details and invoice defaults.
SETTINGS_DOC_ID = "invoice"

DEFAULT_SETTINGS: dict = {
    "business_name": "",
    # The person issuing the invoice, printed under the business name.
    "contact_name": "",
    "address": "",
    "email": "",
    "logo_url": None,
    "default_currency": "USD",
    "default_payment_terms": "Net 14",
    "default_due_days": 14,
    "default_tax_label": "GST",
    "default_tax_percent": 0.0,
    "default_rate": 0.0,
    "invoice_prefix": "INV",
    "reset_sequence_yearly": True,
    # Billing increment for hours, in hours: 0.25 is a quarter hour, 0 is off.
    #
    # A DEFAULT ONLY.  Nothing on the server rounds hours, and nothing should
    # start to on the strength of this field existing.  Rounding happens when
    # the user explicitly asks for it, on the lines they picked; this value only
    # pre-fills that action.  Reading it as "the server rounds hours" would turn
    # a suggestion into a constraint on hours the owner must stay able to type
    # by hand.
    "hours_rounding_increment": 0.25,
    "hours_rounding_direction": "nearest",
}

VALID_ROUNDING_DIRECTIONS = ("nearest", "up", "down")

# An increment longer than a day is a typo, not a billing policy.
MAX_ROUNDING_INCREMENT = 24.0

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class InvoiceSettingsUpdate(BaseModel):
    business_name: Optional[str] = None
    contact_name: Optional[str] = None
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
    hours_rounding_increment: Optional[float] = None
    hours_rounding_direction: Optional[str] = None


class InvoiceSettingsResponse(BaseModel):
    business_name: str
    contact_name: str
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
    hours_rounding_increment: float
    hours_rounding_direction: str
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
        contact_name=data.get("contact_name") or DEFAULT_SETTINGS["contact_name"],
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
        # Settings documents written before rounding existed carry neither key,
        # so both fall back to the default rather than 500ing the read.
        hours_rounding_increment=data.get(
            "hours_rounding_increment", DEFAULT_SETTINGS["hours_rounding_increment"]
        ),
        hours_rounding_direction=data.get(
            "hours_rounding_direction", DEFAULT_SETTINGS["hours_rounding_direction"]
        ),
        datetime_inserted=data.get("datetime_inserted", ""),
        datetime_updated=data.get("datetime_updated", ""),
    )


def _validate_rounding_direction(value: str) -> str:
    """
    Check a rounding direction against the known set.

    Matched exactly, like the tracker split modes: ``"Up"`` is rejected rather
    than falling through to ``"nearest"``, because a direction that silently
    became something else would pre-fill the user's rounding action with the
    opposite of what they asked for.
    """
    if value not in VALID_ROUNDING_DIRECTIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Hours rounding direction must be one of: "
                f"{', '.join(VALID_ROUNDING_DIRECTIONS)}."
            ),
        )
    return value


def _validate_rounding_increment(value: float) -> float:
    """
    Check a billing increment and return it quantised to 4 decimal places.

    ``0`` is legal and means rounding is off.  A negative, a non-finite, or
    anything over a day is refused — this is a correction of an unusable
    request, not a limit on the hours anyone may bill.  The quantisation stops a
    pasted ``0.250000000001`` from becoming the increment every line snaps to.
    """
    if not math.isfinite(value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Hours rounding increment must be a finite number.",
        )
    if value < 0 or value > MAX_ROUNDING_INCREMENT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Hours rounding increment must be between 0 and "
                f"{MAX_ROUNDING_INCREMENT:g} hours (0 turns rounding off)."
            ),
        )
    return round(float(value), 4)


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
    and rates are snapshotted onto each invoice at creation.  The same goes for
    the rounding fields: they pre-fill an action the user takes on chosen lines,
    so changing them rounds nothing that already exists.
    """
    # Validated before the document is read or created, so a bad value 400s
    # without writing anything.  Neither field takes the ``"null"`` sentinel:
    # the increment is a number, and the direction always holds one of the three
    # valid values rather than being cleared.
    increment = (
        None
        if payload.hours_rounding_increment is None
        else _validate_rounding_increment(payload.hours_rounding_increment)
    )
    if payload.hours_rounding_direction is not None:
        _validate_rounding_direction(payload.hours_rounding_direction)

    db = get_firestore_client()
    doc_ref = db.collection("settings").document(SETTINGS_DOC_ID)
    get_invoice_settings(db)  # Ensure the document exists before updating.

    updates: dict = {}

    for field in (
        "business_name",
        "contact_name",
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
        "hours_rounding_increment",
        "hours_rounding_direction",
    ):
        value = getattr(payload, field)
        if value is not None:
            updates[field] = value

    # Store the quantised increment, not the number as pasted.
    if increment is not None:
        updates["hours_rounding_increment"] = increment

    if payload.logo_url is not None:
        updates["logo_url"] = (
            None if payload.logo_url.lower() == "null" else payload.logo_url
        )

    if updates:
        updates["datetime_updated"] = _now_sgt()
        doc_ref.update(updates)

    updated_doc = doc_ref.get()
    return _data_to_settings(updated_doc.to_dict() or {})
