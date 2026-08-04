from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

import pytz
from google.cloud import firestore

SGT = pytz.timezone("Asia/Singapore")

_CENTS = Decimal("0.01")

# ---------------------------------------------------------------------------
# Money helpers
# ---------------------------------------------------------------------------


def _to_decimal(value: Optional[float]) -> Decimal:
    """
    Convert a value to Decimal via its string form.

    Going through ``str`` keeps decimal semantics intuitive: ``1.005`` rounds to
    ``1.01`` rather than following the binary float that is fractionally below
    the half-cent. ``None`` and unparseable values become zero.
    """
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError, TypeError):
        return Decimal("0")


def _quantize(value: Decimal) -> Decimal:
    """Quantise to 2 decimal places using ROUND_HALF_UP."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


def to_money(value: Decimal) -> float:
    """Quantise to 2 dp and return a float for storage in Firestore."""
    return float(_quantize(value))


def round_hours(hours: Optional[float]) -> float:
    """Round hours to 2 dp. ``None`` becomes 0.0."""
    return float(_quantize(_to_decimal(hours)))


def compute_line_amount(hours: Optional[float], rate: Optional[float]) -> float:
    """
    Return ``hours × rate`` quantised to 2 dp.

    Zero-hour and zero-rate lines are legitimate and simply contribute 0.
    """
    return to_money(_to_decimal(hours) * _to_decimal(rate))


def compute_money(
    lines: list[dict],
    discount_type: Optional[str] = None,
    discount_value: Optional[float] = None,
    tax_percent: Optional[float] = None,
) -> dict:
    """
    Recompute every monetary figure on an invoice.

    The server never trusts client-supplied totals — ``amount`` on each line and
    all four invoice totals are derived here from ``hours``, ``rate``, and the
    discount/tax settings. Order of operations is fixed: discount applies to the
    subtotal, tax applies to the discounted subtotal.

    Args:
        lines: Line dicts carrying at least ``hours`` and ``rate``. Every other
            key is preserved untouched.
        discount_type: ``"percent"``, ``"amount"``, or None for no discount.
        discount_value: Percentage or absolute amount, per ``discount_type``.
        tax_percent: Tax rate applied to the discounted subtotal.

    Returns:
        A dict with the recomputed ``lines`` plus ``subtotal``,
        ``discount_amount``, ``tax_amount``, and ``total``.
    """
    computed_lines: list[dict] = []
    subtotal = Decimal("0")

    for line in lines:
        hours = _quantize(_to_decimal(line.get("hours")))
        rate = _to_decimal(line.get("rate"))
        amount = _quantize(hours * rate)

        new_line = dict(line)
        new_line["hours"] = float(hours)
        new_line["rate"] = float(rate)
        new_line["amount"] = float(amount)
        computed_lines.append(new_line)

        subtotal += amount

    subtotal = _quantize(subtotal)

    if discount_type == "percent":
        discount_amount = _quantize(subtotal * _to_decimal(discount_value) / Decimal("100"))
    elif discount_type == "amount":
        discount_amount = _quantize(_to_decimal(discount_value))
    else:
        discount_amount = Decimal("0.00")

    taxable = _quantize(subtotal - discount_amount)
    tax_amount = _quantize(taxable * _to_decimal(tax_percent) / Decimal("100"))
    total = _quantize(taxable + tax_amount)

    return {
        "lines": computed_lines,
        "subtotal": float(subtotal),
        "discount_amount": float(discount_amount),
        "tax_amount": float(tax_amount),
        "total": float(total),
    }


# ---------------------------------------------------------------------------
# Invoice numbering
# ---------------------------------------------------------------------------


def next_sequence(
    counter_data: Optional[dict],
    year: int,
    reset_sequence_yearly: bool = True,
) -> int:
    """
    Return the next sequence number for the given year.

    Starts at 1 when no counter exists yet, and restarts at 1 on a year change
    when ``reset_sequence_yearly`` is set. Otherwise the stored sequence simply
    advances by one.

    Args:
        counter_data: The stored ``settings/invoice_counter`` dict, or None.
        year: The year the invoice is being numbered under.
        reset_sequence_yearly: Whether the sequence restarts each year.

    Returns:
        The sequence number to use, always >= 1.
    """
    if not counter_data:
        return 1

    stored_year = counter_data.get("year")
    stored_seq = counter_data.get("seq", 0)

    if not isinstance(stored_seq, int) or stored_seq < 0:
        stored_seq = 0

    if reset_sequence_yearly and stored_year != year:
        return 1

    return stored_seq + 1


def format_invoice_number(prefix: str, year: int, seq: int) -> str:
    """Return an invoice number shaped ``INV-2026-013``."""
    return f"{prefix}-{year}-{seq:03d}"


@firestore.transactional
def _allocate_number(
    transaction,
    counter_ref,
    prefix: str,
    year: int,
    reset_sequence_yearly: bool,
) -> str:
    """
    Read, bump, and write the counter inside a transaction.

    Running the read and the write in one transaction is what stops two
    concurrent creates from claiming the same number.
    """
    snapshot = counter_ref.get(transaction=transaction)
    counter_data = snapshot.to_dict() if snapshot.exists else None

    seq = next_sequence(counter_data, year, reset_sequence_yearly)
    transaction.set(counter_ref, {"year": year, "seq": seq})

    return format_invoice_number(prefix, year, seq)


def assign_invoice_number(db, settings_data: Optional[dict] = None) -> str:
    """
    Allocate the next invoice number, transactionally.

    Args:
        db: Firestore client.
        settings_data: The ``settings/invoice`` dict, supplying
            ``invoice_prefix`` and ``reset_sequence_yearly``.

    Returns:
        The allocated invoice number, e.g. ``INV-2026-013``.
    """
    settings_data = settings_data or {}
    prefix = settings_data.get("invoice_prefix") or "INV"
    reset_sequence_yearly = settings_data.get("reset_sequence_yearly", True)
    year = datetime.now(tz=SGT).year

    counter_ref = db.collection("settings").document("invoice_counter")
    transaction = db.transaction()

    return _allocate_number(
        transaction, counter_ref, prefix, year, reset_sequence_yearly
    )


# ---------------------------------------------------------------------------
# Snapshots
# ---------------------------------------------------------------------------


def build_bill_to(client_data: Optional[dict]) -> str:
    """
    Build the Bill-To block snapshotted onto an invoice at creation.

    Snapshotting means a later client rename, or deleting the client outright,
    never rewrites a historical invoice.

    Args:
        client_data: Client document dict, or None.

    Returns:
        Client name followed by the billing address, newline separated. Empty
        string when neither is set.
    """
    client_data = client_data or {}
    parts = [
        client_data.get("name"),
        client_data.get("billing_address"),
    ]
    return "\n".join(part for part in parts if part)


def build_issued_by(settings_data: Optional[dict]) -> dict:
    """
    Build the issuer block snapshotted onto an invoice at creation.

    Args:
        settings_data: The ``settings/invoice`` dict, or None.

    Returns:
        A dict with ``business_name``, ``contact_name``, ``address``, and
        ``email``.  ``contact_name`` is the person issuing the invoice; older
        invoices predate it and simply carry an empty string.
    """
    settings_data = settings_data or {}
    return {
        "business_name": settings_data.get("business_name", ""),
        "contact_name": settings_data.get("contact_name") or "",
        "address": settings_data.get("address", ""),
        "email": settings_data.get("email", ""),
    }
