"""
Backfill ``owner_id`` so data written before per-user scoping is visible again.

Every document the API writes now carries ``owner_id`` (the signed-in Google
account's ``sub``), and every read filters on it.  A document without the
field is visible to NOBODY — the API fails closed — until this script assigns
it to an owner.  Run it once, for the account that owns the existing data.

What it does:

- For every document in ``clients``, ``projects``, ``tasks``, ``goals``,
  ``sessions``, ``trackers``, ``invoices`` and ``models`` that has no
  ``owner_id`` (missing or empty), it writes ``owner_id = <owner-sub>``.
  Documents that already have one — anybody's — are left alone, so re-running
  is a no-op (idempotent).
- The old global singletons in ``settings`` (``invoice``, ``tracker``,
  ``invoice_counter``) are COPIED to the per-user ids the API now reads
  (``invoice_<sub>``, ``tracker_<sub>``, ``invoice_counter_<sub>``) with
  ``owner_id`` added.  A per-user document that already exists is never
  overwritten — e.g. if the owner signed in after deploying and the API created
  default settings, the script reports it and leaves both in place; delete the
  per-user document and re-run if you want the old values.  The legacy
  documents themselves are not deleted (nothing reads them any more).
- Any other ``settings`` document without ``owner_id`` is reported, not
  touched.

``datetime_updated`` is not touched — this is a storage migration, not a user
edit.  Existing GCS attachment objects keep their old (un-prefixed) paths;
their URLs live on the parent document and are only ever returned through an
owner-checked read of it.

Finding your ``sub``: sign in to the web app, then in the browser console run
``JSON.parse(atob(localStorage.session_token.split('.')[1])).sub`` (or paste
the ``session_token`` value into jwt.io and read ``sub``).  ``POST /auth/login``
also returns it as ``user.sub``.

Usage, from ``back/`` with the same credentials the app uses
(``GOOGLE_CLOUD_PROJECT``, ``FIRESTORE_DATABASE``, and
``GOOGLE_APPLICATION_CREDENTIALS`` locally):

    python scripts/backfill_owner_id.py --owner-sub 1234567890            # dry run (default)
    python scripts/backfill_owner_id.py --owner-sub 1234567890 --apply    # write
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:  # the app loads .env the same way; harmless when absent
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass

from services.firestore_service import OWNER_FIELD, get_firestore_client  # noqa: E402

BATCH_SIZE = 400  # Firestore caps a batch at 500 writes

# Every collection whose documents carry ``owner_id``.  ``settings`` is handled
# separately because its documents are per-user singletons keyed by id.
OWNED_COLLECTIONS = (
    "clients",
    "projects",
    "tasks",
    "goals",
    "sessions",
    "trackers",
    "invoices",
    "models",
)

# Legacy global singleton id -> per-user id prefix (``<prefix>_<sub>``).  Must
# match ``routers.settings.settings_doc_id`` and
# ``services.invoice_service.invoice_counter_doc_id``.
LEGACY_SETTINGS = {
    "invoice": "invoice",
    "tracker": "tracker",
    "invoice_counter": "invoice_counter",
}


def needs_owner(data: dict) -> bool:
    """True when a document has no owner yet.  Pure, so it can be tested."""
    return not (data or {}).get(OWNER_FIELD)


def plan_settings(settings_docs: dict, owner_sub: str):
    """
    Return ``(copies, notes)`` for the ``settings`` collection.

    ``settings_docs`` maps doc id -> data.  ``copies`` is a list of
    ``(new_doc_id, data)`` to create; ``notes`` lists human-readable reasons
    for anything skipped.  Pure — no Firestore access.
    """
    copies = []
    notes = []
    for legacy_id, prefix in LEGACY_SETTINGS.items():
        if legacy_id not in settings_docs:
            notes.append(f"settings/{legacy_id}: absent, nothing to migrate")
            continue
        target_id = f"{prefix}_{owner_sub}"
        if target_id in settings_docs:
            notes.append(
                f"settings/{legacy_id}: settings/{target_id} already exists, "
                "left both untouched"
            )
            continue
        copies.append((target_id, {**settings_docs[legacy_id], OWNER_FIELD: owner_sub}))

    for doc_id, data in settings_docs.items():
        if doc_id in LEGACY_SETTINGS:
            continue
        if needs_owner(data):
            notes.append(f"settings/{doc_id}: no owner_id and not a known singleton, left alone")
    return copies, notes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--owner-sub",
        required=True,
        help="Google account `sub` that owns all existing data",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run", action="store_true", help="report only (the default)"
    )
    mode.add_argument("--apply", action="store_true", help="write the changes")
    args = parser.parse_args()
    apply = bool(args.apply)
    owner_sub = args.owner_sub.strip()
    if not owner_sub or "/" in owner_sub:
        parser.error("--owner-sub must be a non-empty id without '/'")

    db = get_firestore_client()

    pending = []  # (doc_ref, update)
    print(f"owner_id to assign: {owner_sub}")
    print(f"{'collection':<12} {'scanned':>8} {'owned':>8} {'to backfill':>12}")
    for collection in OWNED_COLLECTIONS:
        scanned = owned = 0
        to_fill = []
        for doc in db.collection(collection).stream():
            scanned += 1
            if needs_owner(doc.to_dict() or {}):
                to_fill.append(doc.reference)
            else:
                owned += 1
        pending.extend((ref, {OWNER_FIELD: owner_sub}) for ref in to_fill)
        print(f"{collection:<12} {scanned:>8} {owned:>8} {len(to_fill):>12}")

    settings_docs = {
        doc.id: (doc.to_dict() or {}) for doc in db.collection("settings").stream()
    }
    copies, notes = plan_settings(settings_docs, owner_sub)
    print(f"{'settings':<12} {len(settings_docs):>8} {'':>8} {len(copies):>12} (copied to per-user ids)")
    for target_id, _ in copies:
        print(f"  will create settings/{target_id}")
    for note in notes:
        print(f"  {note}")

    total = len(pending) + len(copies)
    print(f"total writes: {total}")

    if not apply:
        print("dry run — nothing written. Re-run with --apply to write.")
        return 0

    for start in range(0, len(pending), BATCH_SIZE):
        batch = db.batch()
        for ref, update in pending[start : start + BATCH_SIZE]:
            batch.update(ref, update)
        batch.commit()

    if copies:
        batch = db.batch()
        for target_id, data in copies:
            # create(), not set(): fails rather than clobbering a per-user
            # document written between the read above and this commit.
            batch.create(db.collection("settings").document(target_id), data)
        batch.commit()

    print(f"written: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
