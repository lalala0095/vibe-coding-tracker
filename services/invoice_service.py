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
# Payments
# ---------------------------------------------------------------------------
#
# What the client was billed and what actually landed in the bank are two
# different numbers in two different currencies, and the gap between them — FX
# spread, wire fees, an underpayment — is the thing worth seeing.  Same rules as
# the rest of the money in this file: Decimal from ``str``, quantise each figure
# before summing, and never silently rewrite what was entered.

# Rates are not money.  Six places keeps a rate like 56.803571 meaningful, where
# quantising to cents would flatten it to 56.80 and lose the difference between
# two payments that settled days apart.
_RATE_PLACES = Decimal("0.000001")


def _quantize_rate(value: Decimal) -> Decimal:
    """Quantise an FX rate to 6 dp using ROUND_HALF_UP."""
    return value.quantize(_RATE_PLACES, rounding=ROUND_HALF_UP)


def compute_payments(
    payments: list[dict],
    total: Optional[float] = None,
) -> dict:
    """
    Recompute the payment figures on an invoice.

    Every stored payment carries two amounts: ``amount_paid`` in the currency the
    invoice was raised in, and ``amount_received`` in whatever currency the money
    actually arrived as.  Each is quantised to 2 dp *before* being summed, so the
    per-payment figures on screen always re-add to the totals beside them.

    Received amounts are totalled **per currency**.  Adding 68,400 PHP to 900 SGD
    would produce a number that means nothing, so a mixed-currency invoice gets a
    total for each currency rather than one fictional sum.  ``effective_rate`` is
    likewise only reported when there is exactly one received currency to have a
    rate against.

    ``outstanding`` is deliberately not clamped.  An overpayment yields a
    negative figure and an unpaid invoice yields the full total; the server is a
    calculator, and rewriting either into zero would hide a real discrepancy —
    the same reasoning as the unclamped over-discount.

    Args:
        payments: Payment dicts carrying ``amount_paid``, ``amount_received`` and
            ``received_currency``. Every other key is preserved untouched.
        total: The invoice total, used only to derive ``outstanding``.

    Returns:
        A dict with the recomputed ``payments`` plus ``amount_paid``,
        ``received_totals``, ``outstanding`` and ``effective_rate``.
    """
    computed: list[dict] = []
    paid_total = Decimal("0")
    # Insertion-ordered so the currencies come out in the order first paid,
    # which is stable across recomputation.
    received_by_currency: dict[str, Decimal] = {}

    for payment in payments:
        amount_paid = _quantize(_to_decimal(payment.get("amount_paid")))
        amount_received = _quantize(_to_decimal(payment.get("amount_received")))
        currency = (payment.get("received_currency") or "").strip()

        new_payment = dict(payment)
        new_payment["amount_paid"] = float(amount_paid)
        new_payment["amount_received"] = float(amount_received)
        # Per-payment rate, so a payment that settled at a bad rate is visible
        # on its own row rather than only in the average.
        new_payment["rate"] = (
            float(_quantize_rate(amount_received / amount_paid))
            if amount_paid != 0
            else None
        )
        computed.append(new_payment)

        paid_total += amount_paid
        received_by_currency[currency] = (
            received_by_currency.get(currency, Decimal("0")) + amount_received
        )

    paid_total = _quantize(paid_total)

    received_totals = [
        {"currency": currency, "amount": float(_quantize(amount))}
        for currency, amount in received_by_currency.items()
    ]

    # One currency and something actually paid, or there is no meaningful rate
    # to quote.  None is the honest answer, not 0.
    effective_rate: Optional[float] = None
    if len(received_by_currency) == 1 and paid_total != 0:
        only_total = next(iter(received_by_currency.values()))
        effective_rate = float(_quantize_rate(_quantize(only_total) / paid_total))

    outstanding = _quantize(_to_decimal(total) - paid_total)

    return {
        "payments": computed,
        "amount_paid": float(paid_total),
        "received_totals": received_totals,
        "outstanding": float(outstanding),
        "effective_rate": effective_rate,
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
