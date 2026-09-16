"""
Backfill the multi-project fields on task documents.

A task used to link exactly one project through the scalar ``project_id`` (plus
denormalised ``project_name``/``client_id``/``client_name``).  It now carries
``project_ids``, ``projects`` and ``client_ids`` as well.  The API already reads
an old document correctly (``routers/tasks.py::task_projects``), but Firestore
queries cannot: ``GET /tasks?project_id=X`` uses ``array_contains`` on
``project_ids`` (it also unions a legacy scalar query, so nothing breaks before
this runs), and invoicing matches trackers' tasks by membership.  This script
makes every document carry the new fields.

For every task whose ``project_ids`` is missing or empty and which has a scalar
``project_id``, it writes:

- ``project_ids``  = ``[project_id]``
- ``projects``     = ``[{project_id, project_name, client_id, client_name}]``,
  re-read from the project document (and its client's name from the client
  document when the client still exists);
- ``client_ids``   = ``[client_id]`` (or ``[]`` when the project has no client);
- the legacy scalars ``project_name``/``client_id``/``client_name``, mirrored
  from that entry so the scalars always equal ``projects[0]``.

If the project document is gone the task's own denormalised scalars are used.
Tasks that already have ``project_ids`` are left alone, so re-running is a
no-op (idempotent).  ``datetime_updated`` is not touched — this is a storage
migration, not a user edit.

Usage, from ``back/`` with the same credentials the app uses
(``GOOGLE_CLOUD_PROJECT``, ``FIRESTORE_DATABASE``, and
``GOOGLE_APPLICATION_CREDENTIALS`` locally):

    python scripts/backfill_task_projects.py            # dry run (default)
    python scripts/backfill_task_projects.py --apply    # write
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

from services.firestore_service import get_firestore_client  # noqa: E402

BATCH_SIZE = 400  # Firestore caps a batch at 500 writes


def _load_names(db, collection: str, ids) -> dict:
    """Read several documents in one round trip; missing ids are absent."""
    unique_ids = [i for i in dict.fromkeys(ids) if i]
    if not unique_ids:
        return {}
    refs = [db.collection(collection).document(i) for i in unique_ids]
    return {
        snap.id: (snap.to_dict() or {})
        for snap in db.get_all(refs)
        if snap.exists
    }


def build_update(data: dict, projects: dict, clients: dict):
    """
    Return ``(update_dict, note)`` for one task document, or ``(None, reason)``
    when it needs no write.  Pure — no Firestore access — so it can be tested.
    """
    if [pid for pid in (data.get("project_ids") or []) if pid]:
        return None, "already"
    project_id = data.get("project_id") or ""
    if not project_id:
        return None, "no_project"

    project = projects.get(project_id)
    note = "ok"
    if project is None:
        note = "missing_project"
        entry = {
            "project_id": project_id,
            "project_name": data.get("project_name") or "",
            "client_id": data.get("client_id") or "",
            "client_name": data.get("client_name") or "",
        }
    else:
        client_id = project.get("client_id") or ""
        client = clients.get(client_id)
        client_name = (
            (client or {}).get("name") or project.get("client_name") or ""
        )
        entry = {
            "project_id": project_id,
            "project_name": project.get("name") or "",
            "client_id": client_id,
            "client_name": client_name,
        }

    update = {
        "project_ids": [project_id],
        "projects": [entry],
        "client_ids": [entry["client_id"]] if entry["client_id"] else [],
        "project_name": entry["project_name"],
        "client_id": entry["client_id"],
        "client_name": entry["client_name"],
    }
    return update, note


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run", action="store_true", help="report only (the default)"
    )
    mode.add_argument("--apply", action="store_true", help="write the changes")
    args = parser.parse_args()
    apply = bool(args.apply)

    db = get_firestore_client()
    task_docs = list(db.collection("tasks").stream())
    task_datas = [(doc, doc.to_dict() or {}) for doc in task_docs]

    projects = _load_names(
        db, "projects", (d.get("project_id") for _, d in task_datas)
    )
    clients = _load_names(
        db, "clients", (p.get("client_id") for p in projects.values())
    )

    counts = {"already": 0, "no_project": 0, "ok": 0, "missing_project": 0}
    scalars_changed = 0
    pending = []
    for doc, data in task_datas:
        update, note = build_update(data, projects, clients)
        counts[note] += 1
        if update is None:
            if note == "no_project":
                print(f"  skip {doc.id}: no project_id")
            continue
        if any(
            (data.get(k) or "") != update[k]
            for k in ("project_name", "client_id", "client_name")
        ):
            scalars_changed += 1
            print(
                f"  {doc.id}: refreshing stale names "
                f"({data.get('project_name')!r}/{data.get('client_name')!r} -> "
                f"{update['project_name']!r}/{update['client_name']!r})"
            )
        if note == "missing_project":
            print(f"  {doc.id}: project {data.get('project_id')!r} not found, using task's names")
        pending.append((doc.reference, update))

    print(f"tasks scanned:                {len(task_datas)}")
    print(f"already have project_ids:     {counts['already']}")
    print(f"no project_id (skipped):      {counts['no_project']}")
    print(f"to backfill:                  {len(pending)}")
    print(f"  of which project missing:   {counts['missing_project']}")
    print(f"  of which names refreshed:   {scalars_changed}")

    if not apply:
        print("dry run — nothing written. Re-run with --apply to write.")
        return 0

    for start in range(0, len(pending), BATCH_SIZE):
        batch = db.batch()
        for ref, update in pending[start : start + BATCH_SIZE]:
            batch.update(ref, update)
        batch.commit()
    print(f"written: {len(pending)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
