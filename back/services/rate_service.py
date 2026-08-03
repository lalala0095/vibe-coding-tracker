from typing import Optional


def resolve_rate(
    line_rate: Optional[float],
    project_data: Optional[dict],
    client_data: Optional[dict],
    settings_default_rate: Optional[float] = None,
) -> float:
    """
    Resolve the effective hourly rate for an invoice line.

    Returns the first non-None value of:
    ``line_rate`` -> ``project_data["rate"]`` -> ``client_data["default_rate"]``
    -> ``settings_default_rate`` -> ``0.0``.

    Takes already-fetched documents rather than IDs so the invoice builder can
    fetch projects and clients in bulk and avoid a Firestore read per line.
    Missing documents and missing keys are treated as "no rate set".

    Args:
        line_rate: Per-line override supplied by the user, if any.
        project_data: Project document dict, or None.
        client_data: Client document dict, or None.
        settings_default_rate: Fallback from ``settings/invoice``, if any.

    Returns:
        The resolved rate, always a float.
    """
    project_rate = project_data.get("rate") if project_data else None
    client_rate = client_data.get("default_rate") if client_data else None

    for candidate in (line_rate, project_rate, client_rate, settings_default_rate):
        if candidate is not None:
            return float(candidate)

    return 0.0


def resolve_currency(
    client_data: Optional[dict],
    settings_default_currency: str = "SGD",
) -> str:
    """
    Resolve the currency label for an invoice.

    Returns ``client_data["currency"]`` when it is present and non-empty,
    otherwise ``settings_default_currency``. A missing document or key falls
    back to the default.

    Args:
        client_data: Client document dict, or None.
        settings_default_currency: Fallback from ``settings/invoice``.

    Returns:
        The resolved currency label.
    """
    client_currency = client_data.get("currency") if client_data else None
    return client_currency if client_currency else settings_default_currency
