import logging
import os
import re
import threading
import time
from datetime import timedelta
from typing import Optional
from urllib.parse import unquote

import google.auth
from google.auth.transport.requests import Request as AuthRequest
from google.cloud import storage
from google.oauth2 import service_account

logger = logging.getLogger(__name__)

_client: storage.Client | None = None

# How long a signed attachment URL stays valid.
SIGNED_URL_TTL = timedelta(minutes=60)
# A cached signed URL is handed out again only while it has at least this long
# left, so a link the frontend just received is always good for 40+ minutes.
_SIGNED_URL_MIN_REMAINING = timedelta(minutes=20)
_SIGNED_URL_CACHE_MAX = 5000
# After credentials fail to resolve, don't retry (and re-probe the metadata
# server) for this long — a list of 50 attachments must not wait 50 times.
_CREDENTIALS_RETRY_SECONDS = 300
_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


def get_storage_client() -> storage.Client:
    """
    Return a singleton GCS client.

    Authentication is resolved automatically:
    - Locally: GOOGLE_APPLICATION_CREDENTIALS env var.
    - Cloud Run: attached service account.
    """
    global _client
    if _client is None:
        _client = storage.Client()
    return _client


def get_bucket_name() -> str:
    bucket_name = os.getenv("GCS_BUCKET_NAME")
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME environment variable is not set.")
    return bucket_name


def owned_blob_name(owner_id: str, kind: str, parent_id: str, filename: str) -> str:
    """
    Return the object path for an attachment: ``<owner_id>/<kind>/<parent_id>/<filename>``.

    Every new object lives under its owner's prefix, so one user's files can
    never share a path with another's, and per-user cleanup or IAM conditions
    can target a single prefix.  Objects written before per-user data existed
    keep their old ``<kind>/<parent_id>/...`` paths.  Either way the blob
    name is stored on the parent document and only ever signed through an
    owner-checked read of that document.

    The filename's directory part is dropped, so a crafted upload name cannot
    place the object outside its parent's folder.
    """
    if not owner_id:
        raise ValueError("owner_id is required for an attachment path.")
    safe_name = (filename or "").replace("\\", "/").rsplit("/", 1)[-1] or "file"
    return f"{owner_id}/{kind}/{parent_id}/{safe_name}"


def upload_file(
    file_bytes: bytes,
    destination_blob_name: str,
    content_type: str,
) -> None:
    """
    Upload bytes to GCS at ``destination_blob_name``.

    The bucket is private: callers store the blob name on the parent document
    and hand out short-lived signed URLs from owner-checked reads (see
    ``signed_attachments``).  No public URL is returned or stored.

    Args:
        file_bytes: Raw file content.
        destination_blob_name: Full path inside the bucket, from
            ``owned_blob_name``.
        content_type: MIME type of the file.
    """
    client = get_storage_client()
    bucket = client.bucket(get_bucket_name())
    blob = bucket.blob(destination_blob_name)
    blob.upload_from_string(file_bytes, content_type=content_type)


def delete_file(destination_blob_name: str) -> None:
    """
    Delete a blob from GCS. Silently ignores blobs that do not exist.

    Args:
        destination_blob_name: Full path inside the bucket.
    """
    client = get_storage_client()
    bucket_name = get_bucket_name()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(destination_blob_name)
    blob.delete(if_generation_match=None)


# ---------------------------------------------------------------------------
# Attachment entries: blob names, legacy public URLs, signed URLs
# ---------------------------------------------------------------------------

_PERCENT_ESCAPE = re.compile(r"%[0-9A-Fa-f]{2}")


def blob_name_from_url(url: str, bucket_name: str) -> Optional[str]:
    """
    Derive the blob name from a legacy public URL stored on an attachment.

    Accepts ``https://storage.googleapis.com/<bucket>/<path>`` (what this app
    always wrote), plus the ``https://<bucket>.storage.googleapis.com/<path>``
    and ``gs://<bucket>/<path>`` spellings.  Returns ``None`` for anything
    else — in particular a URL for a different bucket — so a stray URL can
    never be turned into a signature for some other object.

    The app wrote these URLs with the raw, unencoded object name, so the path
    is decoded only when it looks encoded: it contains a ``%XX`` escape and no
    character an encoder would have escaped (a space, non-ASCII, ...).
    """
    if not url or not bucket_name:
        return None
    path: Optional[str] = None
    for prefix in (
        f"https://storage.googleapis.com/{bucket_name}/",
        f"http://storage.googleapis.com/{bucket_name}/",
        f"https://{bucket_name}.storage.googleapis.com/",
        f"gs://{bucket_name}/",
    ):
        if url.startswith(prefix):
            path = url[len(prefix):]
            break
    if not path:
        return None
    path = path.split("?", 1)[0].split("#", 1)[0]
    looks_raw = any(ch == " " or ord(ch) > 126 for ch in path)
    if _PERCENT_ESCAPE.search(path) and not looks_raw:
        path = unquote(path)
    return path or None


def attachment_blob_name(attachment: dict, bucket_name: Optional[str] = None) -> Optional[str]:
    """
    Return the blob name of a stored attachment entry.

    New entries carry ``blob_name``; legacy ones only ``gcs_url`` (a public
    URL), from which the name is derived.
    """
    if not isinstance(attachment, dict):
        return None
    blob_name = attachment.get("blob_name")
    if isinstance(blob_name, str) and blob_name:
        return blob_name
    bucket_name = bucket_name or os.getenv("GCS_BUCKET_NAME", "")
    return blob_name_from_url(attachment.get("gcs_url") or "", bucket_name)


def attachment_prefixes(owner_id: Optional[str], kind: str, parent_id: str) -> tuple[str, ...]:
    """
    The only folders an attachment of ``<kind>/<parent_id>`` may live in.

    ``<owner_id>/<kind>/<parent_id>/`` for uploads since per-user data, and the
    legacy ``<kind>/<parent_id>/``.  Signing and deletion refuse any blob
    outside these, so even a corrupted attachment entry cannot reach an object
    belonging to another document or another user.
    """
    prefixes = [f"{kind}/{parent_id}/"]
    if owner_id:
        prefixes.insert(0, f"{owner_id}/{kind}/{parent_id}/")
    return tuple(prefixes)


def owned_attachment_blob_name(
    attachment: dict, owner_id: Optional[str], kind: str, parent_id: str
) -> Optional[str]:
    """``attachment_blob_name``, or ``None`` when it falls outside the parent's folders."""
    blob_name = attachment_blob_name(attachment)
    if not blob_name:
        return None
    if ".." in blob_name.split("/") or not blob_name.startswith(
        attachment_prefixes(owner_id, kind, parent_id)
    ):
        logger.warning(
            "Attachment blob '%s' is outside %s/%s's folder; refusing it.",
            blob_name, kind, parent_id,
        )
        return None
    return blob_name


class SigningUnavailable(RuntimeError):
    """The runtime has no way to sign a URL (no key and no service account)."""


_cred_lock = threading.Lock()
_credentials = None
_credentials_error: Optional[tuple[float, str]] = None


def _signing_kwargs() -> dict:
    """
    Return the extra ``generate_signed_url`` arguments for these credentials.

    - A service-account key file (``GOOGLE_APPLICATION_CREDENTIALS``) signs
      locally with its private key.
    - Anything else signs through the IAM Credentials ``signBlob`` API, which
      needs the signer's email plus an access token.  On Cloud Run that is the
      runtime service account signing as itself, which needs
      ``roles/iam.serviceAccountTokenCreator`` on itself.  Locally, with user
      ADC (``gcloud auth application-default login``), set
      ``GCS_SIGNING_SERVICE_ACCOUNT`` to a service account you hold that role
      on; impersonated ADC
      (``--impersonate-service-account``) works without it.

    Credentials are resolved once and refreshed when their token expires.
    """
    global _credentials, _credentials_error
    with _cred_lock:
        if _credentials is None:
            if _credentials_error and time.monotonic() - _credentials_error[0] < _CREDENTIALS_RETRY_SECONDS:
                raise SigningUnavailable(_credentials_error[1])
            try:
                _credentials, _ = google.auth.default(scopes=[_CLOUD_PLATFORM_SCOPE])
                _credentials_error = None
            except Exception as exc:
                msg = f"No Google credentials to sign attachment URLs with: {exc}"
                _credentials_error = (time.monotonic(), msg)
                raise SigningUnavailable(msg) from exc

        creds = _credentials
        if isinstance(creds, service_account.Credentials):
            return {"credentials": creds}

        if not creds.valid:
            creds.refresh(AuthRequest())

        email = os.getenv("GCS_SIGNING_SERVICE_ACCOUNT") or getattr(
            creds, "service_account_email", None
        )
        if not email or email == "default":
            raise SigningUnavailable(
                "These Google credentials cannot sign URLs (user credentials, no "
                "service account). Set GCS_SIGNING_SERVICE_ACCOUNT to a service "
                "account you hold roles/iam.serviceAccountTokenCreator on, or use "
                "a service-account key / impersonated ADC."
            )
        return {"service_account_email": email, "access_token": creds.token}


_url_cache_lock = threading.Lock()
_url_cache: dict[str, tuple[str, float]] = {}


def generate_signed_url(blob_name: str) -> str:
    """
    Return a V4 signed GET URL for ``blob_name``, valid for ``SIGNED_URL_TTL``.

    Never call this with a path from a request: only with a blob name read off
    a document the caller owns (``signed_attachments`` does that).

    A URL is cached and reused while it has at least
    ``_SIGNED_URL_MIN_REMAINING`` left, because on Cloud Run each signature is
    an IAM ``signBlob`` round trip, not local CPU.  Raises on failure.
    """
    now = time.time()
    with _url_cache_lock:
        cached = _url_cache.get(blob_name)
        if cached and cached[1] - now >= _SIGNED_URL_MIN_REMAINING.total_seconds():
            return cached[0]

    kwargs = _signing_kwargs()
    client = get_storage_client()
    blob = client.bucket(get_bucket_name()).blob(blob_name)
    url = blob.generate_signed_url(
        version="v4", expiration=SIGNED_URL_TTL, method="GET", **kwargs
    )

    with _url_cache_lock:
        if len(_url_cache) >= _SIGNED_URL_CACHE_MAX:
            _url_cache.clear()
        _url_cache[blob_name] = (url, now + SIGNED_URL_TTL.total_seconds())
    return url


def signed_attachments(
    attachments, owner_id: Optional[str], kind: str, parent_id: str
) -> list[dict]:
    """
    Turn stored attachment entries into response entries ``{name, gcs_url}``.

    ``gcs_url`` is a fresh short-lived signed URL, or ``None`` when the entry
    has no usable blob name or signing fails.  A failure is logged and never
    raised, so one bad attachment cannot 500 a whole task or goal list.

    Only ever called from ``_doc_to_x`` on a document already fetched through
    an owner check, with that document's own id and ``owner_id``.
    """
    out: list[dict] = []
    for a in attachments or []:
        if not isinstance(a, dict):
            continue
        url: Optional[str] = None
        blob_name = owned_attachment_blob_name(a, owner_id, kind, parent_id)
        if blob_name:
            try:
                url = generate_signed_url(blob_name)
            except Exception as exc:
                logger.warning("Could not sign URL for attachment '%s': %s", blob_name, exc)
        out.append({"name": a.get("name", ""), "gcs_url": url})
    return out


def delete_attachments(
    attachments, owner_id: Optional[str], kind: str, parent_id: str
) -> None:
    """
    Best-effort delete of a document's attachment blobs (stored or derived
    names, restricted to the document's own folders).  Failures are logged.
    """
    for a in attachments or []:
        blob_name = owned_attachment_blob_name(a, owner_id, kind, parent_id)
        if not blob_name:
            continue
        try:
            delete_file(blob_name)
        except Exception as exc:
            logger.warning("Failed to delete GCS blob '%s': %s", blob_name, exc)
