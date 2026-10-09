import os
from typing import Iterable

from fastapi import HTTPException, status
from google.cloud import firestore

_client: firestore.Client | None = None

# The field every document carries to say which signed-in user owns it.  Set
# from the session JWT's ``sub`` (``auth.owner_id_of``).  A document without it
# — written before per-user data existed — is visible to nobody until
# ``scripts/backfill_owner_id.py`` assigns it.
OWNER_FIELD = "owner_id"


def get_firestore_client() -> firestore.Client:
    """
    Return a singleton Firestore client.

    Authentication is resolved automatically by the Google Cloud SDK:
    - Locally: via GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account key.
    - On Cloud Run: via the attached service account / Workload Identity.
    """
    global _client
    if _client is None:
        project = os.getenv("GOOGLE_CLOUD_PROJECT")
        database = os.getenv("FIRESTORE_DATABASE", "(default)")
        _client = firestore.Client(project=project, database=database)
    return _client


def _valid_doc_id(doc_id) -> bool:
    """
    True for an id that can name a single document.

    Blank ids and ids with a slash are refused up front: ``document("")``
    raises, and ``document("a/b")`` would address a different path entirely.
    Both are treated as not-found rather than reaching Firestore.
    """
    return isinstance(doc_id, str) and bool(doc_id) and "/" not in doc_id


def owned_query(db, collection: str, owner_id: str):
    """
    Return ``collection`` filtered to one owner's documents.

    The starting point for EVERY list or search in the app.  Further equality
    filters may be chained on it (several equalities need no composite index),
    but an ``order_by`` on another field would — sort in Python instead.
    """
    if not owner_id:
        # Defence in depth: never let an empty owner match legacy documents.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session token has no user id. Please sign in again.",
        )
    return db.collection(collection).where(OWNER_FIELD, "==", owner_id)


def is_owned(snapshot, owner_id: str) -> bool:
    """True when ``snapshot`` exists and belongs to ``owner_id``."""
    if snapshot is None or not snapshot.exists or not owner_id:
        return False
    return (snapshot.to_dict() or {}).get(OWNER_FIELD) == owner_id


def get_owned_doc(db, collection: str, doc_id: str, owner_id: str, label: str):
    """
    Fetch one document the caller owns, or raise the ordinary 404.

    A document that exists but belongs to somebody else — or to nobody, being
    un-backfilled — gets exactly the same 404 as one that does not exist, so a
    response never reveals that an id is real.  Never a 403.

    Args:
        db: Firestore client.
        collection: Collection name.
        doc_id: Document id from the request.
        owner_id: The caller's ``sub``.
        label: Noun for the error, e.g. ``"Project"`` →
            ``"Project 'abc' not found."``.

    Returns:
        The document snapshot (``.reference`` gives its ref).
    """
    snapshot = None
    if _valid_doc_id(doc_id):
        snapshot = db.collection(collection).document(doc_id).get()
    if not is_owned(snapshot, owner_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{label} '{doc_id}' not found.",
        )
    return snapshot


def get_owned_docs(db, collection: str, doc_ids: Iterable, owner_id: str) -> dict:
    """
    Bulk-read documents in one round trip, keeping only the caller's.

    Returns ``{doc_id: data}``.  Missing ids, invalid ids, and documents owned by
    anyone else are simply absent, exactly as a missing document always was for
    the bulk readers — the caller cannot tell them apart.
    """
    unique_ids = [i for i in dict.fromkeys(doc_ids or []) if _valid_doc_id(i)]
    if not unique_ids:
        return {}
    refs = [db.collection(collection).document(i) for i in unique_ids]
    return {
        snapshot.id: (snapshot.to_dict() or {})
        for snapshot in db.get_all(refs)
        if is_owned(snapshot, owner_id)
    }


def require_owned_ids(
    db, collection: str, doc_ids: Iterable, owner_id: str, label: str
) -> dict:
    """
    Like ``get_owned_docs``, but 404 on the first id the caller does not own.

    For request bodies that reference other documents by id: an id that is
    missing and one that belongs to another user get the same 404.
    """
    wanted = [i for i in dict.fromkeys(doc_ids or []) if i]
    owned = get_owned_docs(db, collection, wanted, owner_id)
    for doc_id in wanted:
        if doc_id not in owned:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"{label} '{doc_id}' not found.",
            )
    return owned
