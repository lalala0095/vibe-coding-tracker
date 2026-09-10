import math
import re
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
    # The currency the owner actually receives money in, when it differs from the
    # currency invoiced.  Empty means "not set", and the payment form falls back
    # to the invoice's own currency rather than guessing — so this stays empty by
    # default instead of naming a currency nobody chose.
    "payout_currency": "",
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

# A currency code: the ISO-4217 alphabetic codes are three letters, with a
# little room either side for the shorter and longer things people actually
# type.  Letters only — a code with a digit or a space in it is a typo.
CURRENCY_CODE_RE = re.compile(r"^[A-Z]{2,5}$")

# The singleton document holding tracker defaults.
TRACKER_SETTINGS_DOC_ID = "tracker"

DEFAULT_TRACKER_SETTINGS: dict = {
    "auto_name_enabled": True,
    "auto_name_template": "{date} tasks",
}

# The token names a tracker-name template may use.
#
# Mirrored in `front/src/lib/trackerName.ts` (`TRACKER_NAME_TOKENS`), which owns
# the rendering.  The two lists MUST stay in step: a token added here and not
# there renders as its own literal braces in the tracker's title, and one added
# there and not here is refused on save.
VALID_NAME_TOKENS = (
    "date",
    "date_short",
    "day",
    "month",
    "month_name",
    "month_short",
    "year",
    "weekday",
    "weekday_short",
    "time",
)

# A title longer than this is a paste accident, not a naming scheme.
MAX_NAME_TEMPLATE_LENGTH = 200

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
    payout_currency: Optional[str] = None
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
    payout_currency: str
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


class TrackerSettingsUpdate(BaseModel):
    auto_name_enabled: Optional[bool] = None
    auto_name_template: Optional[str] = None


class TrackerSettingsResponse(BaseModel):
    auto_name_enabled: bool
    auto_name_template: str
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
        # Settings documents written before the payout currency existed carry no
        # key, so this falls back to the empty default rather than 500ing.
        payout_currency=data.get(
            "payout_currency", DEFAULT_SETTINGS["payout_currency"]
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


def _validate_payout_currency(value: str) -> str:
    """
    Normalise a payout currency and return it trimmed and uppercased.

    Empty is legal and is how the field is cleared: it means "not set", and the
    payment form then falls back to the invoice's own currency instead of
    guessing at the owner's.

    The ``"null"`` sentinel used elsewhere in the repo is refused outright, in
    any case.  A currency is printed on a client-facing document, so a field
    storing the literal string ``"null"`` would put that word in front of a
    client — the error says to clear it with an empty value instead of quietly
    reinterpreting what was sent.
    """
    normalised = value.strip().upper()

    if normalised == "":
        return ""

    if normalised == "NULL":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Payout currency cannot be the word 'null'. "
                "Send an empty value to clear it."
            ),
        )

    if not CURRENCY_CODE_RE.match(normalised):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Payout currency must be 2-5 letters, such as 'PHP', "
                "or empty to clear it."
            ),
        )

    return normalised


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


def _data_to_tracker_settings(data: dict) -> TrackerSettingsResponse:
    return TrackerSettingsResponse(
        # Both keys fall back to the default rather than 500ing the read, so a
        # settings document written before tracker naming existed still loads.
        auto_name_enabled=data.get(
            "auto_name_enabled", DEFAULT_TRACKER_SETTINGS["auto_name_enabled"]
        ),
        auto_name_template=data.get(
            "auto_name_template", DEFAULT_TRACKER_SETTINGS["auto_name_template"]
        ),
        datetime_inserted=data.get("datetime_inserted", ""),
        datetime_updated=data.get("datetime_updated", ""),
    )


def _validate_name_template(value: str) -> str:
    """
    Check a tracker-name template and return it unchanged.

    Every ``{token}`` must name something the frontend can render.  A typo like
    ``{dat}`` would otherwise be stored happily and then print itself literally
    in the tracker's title, which reads as the app being broken rather than as a
    typo — so it is refused at the point it is typed, naming both the offending
    token and the valid set.

    An empty or whitespace-only template is legal: it means the same thing as
    auto-naming being switched off, and refusing it would stop someone clearing
    the field.  The value is returned exactly as typed rather than stripped,
    because the frontend trims when it renders.

    Note there is no ``"null"`` sentinel here.  ``auto_name_template`` is a plain
    string that is cleared by sending ``""``, so a user who genuinely wants the
    word "null" in their tracker titles can have it.
    """
    if len(value) > MAX_NAME_TEMPLATE_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Tracker name template must be "
                f"{MAX_NAME_TEMPLATE_LENGTH} characters or fewer."
            ),
        )

    unknown = [
        name
        for name in re.findall(r"\{([a-z_]+)\}", value)
        if name not in VALID_NAME_TOKENS
    ]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unknown tracker name token(s): {', '.join(unknown)}. "
                f"Valid tokens are: {', '.join(VALID_NAME_TOKENS)}."
            ),
        )

    # The pattern above is lowercase-only, matching the frontend's, so `{DATE}`
    # matches nothing and would sail through to print as literal braces — the
    # exact failure this validator exists to stop.  Caught here, but only when
    # the braces hold a real token in the wrong case, so an unrelated `{FOO}`
    # someone wants in their titles is still left alone.
    miscased = [
        name
        for name in re.findall(r"\{([A-Za-z_]+)\}", value)
        if name not in VALID_NAME_TOKENS and name.lower() in VALID_NAME_TOKENS
    ]
    if miscased:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Tracker name token(s) must be lowercase: {', '.join(miscased)} "
                f"should be {', '.join('{' + n.lower() + '}' for n in miscased)}."
            ),
        )

    return value


def get_tracker_settings(db) -> dict:
    """
    Return the tracker settings document, creating it with defaults if absent.

    Mirrors :func:`get_invoice_settings` so callers that need the naming
    defaults can read them without going through the HTTP layer.

    Args:
        db: Firestore client.

    Returns:
        The raw settings dict.
    """
    doc_ref = db.collection("settings").document(TRACKER_SETTINGS_DOC_ID)
    doc = doc_ref.get()
    if doc.exists:
        return doc.to_dict() or {}

    now = _now_sgt()
    data = {
        **DEFAULT_TRACKER_SETTINGS,
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
    - Pass ``payout_currency=""`` to clear the payout currency; the ``"null"``
      sentinel is refused there, since a currency prints on a client document.
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

    # Validated in the same place, and for the same reason: a payout currency
    # that failed the check must not leave a half-written document behind.  This
    # one is cleared with ``""``, never with the ``"null"`` sentinel.
    payout_currency = (
        None
        if payload.payout_currency is None
        else _validate_payout_currency(payload.payout_currency)
    )

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
        "payout_currency",
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

    # Likewise store the normalised currency, not the casing as typed.
    if payout_currency is not None:
        updates["payout_currency"] = payout_currency

    if payload.logo_url is not None:
        updates["logo_url"] = (
            None if payload.logo_url.lower() == "null" else payload.logo_url
        )

    if updates:
        updates["datetime_updated"] = _now_sgt()
        doc_ref.update(updates)

    updated_doc = doc_ref.get()
    return _data_to_settings(updated_doc.to_dict() or {})


@router.get("/tracker", response_model=TrackerSettingsResponse)
async def get_tracker_settings_endpoint(
    _user: Annotated[dict, Depends(get_current_user)],
) -> TrackerSettingsResponse:
    """
    Return the tracker settings singleton.

    The document is created with defaults on first read, so this never 404s.
    """
    db = get_firestore_client()
    return _data_to_tracker_settings(get_tracker_settings(db))


@router.put("/tracker", response_model=TrackerSettingsResponse)
async def update_tracker_settings(
    payload: TrackerSettingsUpdate,
    _user: Annotated[dict, Depends(get_current_user)],
) -> TrackerSettingsResponse:
    """
    Update the tracker settings singleton.

    - Creates the document with defaults first if it does not exist yet.
    - Only fields present in the payload are updated.

    This changes nothing but what a NEW tracker's title arrives pre-filled with.
    It never renames a tracker that already exists, and the pre-filled title is
    an ordinary editable field: the template is a starting point the owner types
    over, never a name they are held to.
    """
    # Validated before the document is read or created, so a bad template 400s
    # without writing anything.
    if payload.auto_name_template is not None:
        _validate_name_template(payload.auto_name_template)

    db = get_firestore_client()
    doc_ref = db.collection("settings").document(TRACKER_SETTINGS_DOC_ID)
    get_tracker_settings(db)  # Ensure the document exists before updating.

    updates: dict = {}

    for field in ("auto_name_enabled", "auto_name_template"):
        value = getattr(payload, field)
        if value is not None:
            updates[field] = value

    if updates:
        updates["datetime_updated"] = _now_sgt()
        doc_ref.update(updates)

    updated_doc = doc_ref.get()
    return _data_to_tracker_settings(updated_doc.to_dict() or {})
