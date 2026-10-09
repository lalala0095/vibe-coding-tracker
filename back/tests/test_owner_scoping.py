"""
Per-user data scoping, exercised end to end through the FastAPI app against an
in-memory fake Firestore.

User A creates one of everything; user B must then see empty lists, get the
ordinary 404 on every one of A's ids, and be unable to reference A's documents
from their own requests.  Legacy documents with no ``owner_id`` must be
invisible to both.

The fake also enforces the composite-index rule CLAUDE.md relies on: a query
with an equality filter plus an ``order_by`` on a different field raises, so a
regression to that pattern fails here instead of in production.

Run from ``back/`` (needs the app requirements plus ``httpx``):

    python -m unittest tests.test_owner_scoping -v
"""

import copy
import itertools
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("GCS_BUCKET_NAME", "test-bucket")

import jwt  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# ---------------------------------------------------------------------------
# Fake Firestore
# ---------------------------------------------------------------------------

_ids = itertools.count(1)


class CompositeIndexRequired(Exception):
    pass


class FakeSnap:
    def __init__(self, ref, data):
        self.reference = ref
        self.id = ref.id
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return copy.deepcopy(self._data) if self._data is not None else None


class FakeDocRef:
    def __init__(self, db, collection, doc_id):
        self._db, self._collection, self.id = db, collection, doc_id

    @property
    def _store(self):
        return self._db.data.setdefault(self._collection, {})

    def get(self, transaction=None):
        return FakeSnap(self, copy.deepcopy(self._store.get(self.id)))

    def set(self, data):
        self._store[self.id] = copy.deepcopy(data)

    def create(self, data):
        if self.id in self._store:
            raise RuntimeError("already exists")
        self.set(data)

    def update(self, data):
        if self.id not in self._store:
            raise RuntimeError(f"no document to update: {self._collection}/{self.id}")
        self._store[self.id].update(copy.deepcopy(data))

    def delete(self):
        self._store.pop(self.id, None)


class FakeQuery:
    def __init__(self, db, collection, filters=(), order=None):
        self._db, self._collection = db, collection
        self._filters, self._order = list(filters), order

    def where(self, field, op, value):
        return FakeQuery(self._db, self._collection, self._filters + [(field, op, value)], self._order)

    def order_by(self, field, direction="ASCENDING"):
        return FakeQuery(self._db, self._collection, self._filters, (field, direction))

    def _matches(self, data):
        for field, op, value in self._filters:
            if op == "==" and data.get(field) != value:
                return False
            if op == "array_contains" and value not in (data.get(field) or []):
                return False
        return True

    def stream(self):
        if self._order and any(f != self._order[0] for f, _, _ in self._filters):
            raise CompositeIndexRequired(f"{self._collection}: {self._filters} + order_by {self._order}")
        store = self._db.data.get(self._collection, {})
        snaps = [
            FakeSnap(FakeDocRef(self._db, self._collection, doc_id), copy.deepcopy(data))
            for doc_id, data in store.items()
            if self._matches(data)
        ]
        if self._order:
            field, direction = self._order
            snaps.sort(key=lambda s: s._data.get(field, ""), reverse=direction == "DESCENDING")
        return iter(snaps)


class FakeCollection(FakeQuery):
    def document(self, doc_id=None):
        if doc_id is not None and (not doc_id or "/" in doc_id):
            raise ValueError("bad document id")
        return FakeDocRef(self._db, self._collection, doc_id or f"id{next(_ids):05d}")

    def add(self, data):
        ref = self.document()
        ref.set(data)
        return None, ref


class FakeBatch:
    def __init__(self):
        self._ops = []

    def set(self, ref, data):
        self._ops.append(lambda: ref.set(data))

    def create(self, ref, data):
        self._ops.append(lambda: ref.create(data))

    def update(self, ref, data):
        self._ops.append(lambda: ref.update(data))

    def commit(self):
        for op in self._ops:
            op()


class FakeTransaction:
    def set(self, ref, data):
        ref.set(data)


class FakeDB:
    def __init__(self):
        self.data = {}

    def collection(self, name):
        return FakeCollection(self, name)

    def get_all(self, refs):
        return [ref.get() for ref in refs]

    def batch(self):
        return FakeBatch()

    def transaction(self):
        return FakeTransaction()


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------


def _token(sub=None, **extra):
    payload = {"email": "x@example.com", "exp": int(time.time()) + 3600, **extra}
    if sub is not None:
        payload["sub"] = sub
    return jwt.encode(payload, os.environ["SECRET_KEY"], algorithm="HS256")


class OwnerScopingTest(unittest.TestCase):
    def setUp(self):
        import main
        from services import invoice_service

        self.db = FakeDB()
        self.uploads = []
        patches = [
            mock.patch(
                f"{module}.get_firestore_client", return_value=self.db
            )
            for module in (
                "routers.clients", "routers.projects", "routers.models",
                "routers.goals", "routers.tasks", "routers.sessions",
                "routers.trackers", "routers.settings", "routers.invoices",
            )
        ]
        fake_upload = lambda data, name, ctype: (  # noqa: E731
            self.uploads.append(name) or f"https://storage.googleapis.com/test-bucket/{name}"
        )
        # Attachment signing: a fake signer that records what it was asked to
        # sign, and a fake delete.  Nothing here talks to GCS or IAM.
        self.signed, self.deleted = [], []
        fake_sign = lambda name: (  # noqa: E731
            self.signed.append(name) or f"https://storage.googleapis.com/test-bucket/{name}?X-Goog-Signature=fake"
        )
        patches += [
            mock.patch("services.storage_service.generate_signed_url", fake_sign),
            mock.patch("services.storage_service.delete_file", self.deleted.append),
            mock.patch("routers.goals.upload_file", fake_upload),
            mock.patch("routers.tasks.upload_file", fake_upload),
            # The real one is wrapped in @firestore.transactional; run the bare body.
            mock.patch.object(
                invoice_service, "_allocate_number", invoice_service._allocate_number.to_wrap
            ),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        self.client = TestClient(main.app)
        self.a = {"Authorization": f"Bearer {_token('sub-A')}"}
        self.b = {"Authorization": f"Bearer {_token('sub-B')}"}

    def _ok(self, resp, code=200):
        self.assertEqual(resp.status_code, code, resp.text)
        return resp.json()

    def _seed_user_a(self):
        c = self.client
        ids = {}
        ids["client"] = self._ok(c.post("/clients", json={"name": "Acme", "default_rate": 100}, headers=self.a), 201)["id"]
        ids["project"] = self._ok(c.post("/projects", json={"name": "Site", "client_id": ids["client"]}, headers=self.a), 201)["id"]
        ids["task"] = self._ok(c.post(
            "/tasks", data={"title": "Build", "project_ids": ids["project"]},
            files={"attachments": ("spec.txt", b"secret", "text/plain")}, headers=self.a), 201)["id"]
        ids["model"] = self._ok(c.post("/models", json={"name": "Opus"}, headers=self.a), 201)["id"]
        ids["goal"] = self._ok(c.post(
            "/goals", data={"model_id": ids["model"], "goal": "do it", "task_id": ids["task"]},
            files={"attachments": ("prompt.md", b"p", "text/markdown")}, headers=self.a), 201)["id"]
        ids["tracker"] = self._ok(c.post("/trackers", json={
            "title": "Mon", "start_time": "2026-10-05T09:00:00+08:00",
            "end_time": "2026-10-05T11:00:00+08:00", "task_ids": [ids["task"]]}, headers=self.a), 201)["id"]
        ids["session"] = self._ok(c.post("/sessions", json={
            "task_id": ids["task"], "start_time": "2026-10-05T09:00:00+08:00",
            "end_time": "2026-10-05T10:00:00+08:00"}, headers=self.a), 201)["id"]
        self._ok(c.put("/settings/invoice", json={"business_name": "A Corp"}, headers=self.a))
        preview = self._ok(c.post("/invoices/preview", json={
            "client_id": ids["client"], "period_start": "2026-10-01", "period_end": "2026-10-31"}, headers=self.a))
        self.assertEqual(len(preview["lines"]), 2)  # one time-entry line, one tracker line
        inv = self._ok(c.post("/invoices", json={
            "client_id": ids["client"], "lines": [l for l in preview["lines"] if l["session_ids"]]}, headers=self.a), 201)
        ids["invoice"] = inv["id"]
        ids["invoice_number"] = inv["invoice_number"]
        return ids

    def test_user_b_cannot_see_or_touch_user_a_data(self):
        ids = self._seed_user_a()
        c = self.client

        # Every stored document carries A's owner_id; no response exposes it.
        for collection, docs in self.db.data.items():
            for doc_id, data in docs.items():
                self.assertEqual(data.get("owner_id"), "sub-A", f"{collection}/{doc_id}")
        self.assertNotIn("owner_id", c.get(f"/clients/{ids['client']}", headers=self.a).text)

        # Attachments are stored under A's prefix.
        self.assertTrue(self.uploads)
        for name in self.uploads:
            self.assertTrue(name.startswith("sub-A/"), name)

        # A sees their own data.
        for path in ("/clients", "/projects", "/tasks", "/models", "/goals", "/sessions", "/trackers", "/invoices"):
            self.assertEqual(len(self._ok(c.get(path, headers=self.a))), 1, path)

        # B sees nothing, with and without filters.
        for path in (
            "/clients", "/projects", f"/projects?client_id={ids['client']}", "/tasks",
            f"/tasks?project_id={ids['project']}", "/models", "/goals", f"/goals?task_id={ids['task']}",
            "/sessions", f"/sessions?task_id={ids['task']}", f"/sessions?client_id={ids['client']}",
            "/trackers", "/invoices", f"/invoices?client_id={ids['client']}",
        ):
            self.assertEqual(self._ok(c.get(path, headers=self.b)), [], path)

        # By-id access: identical 404 to a nonexistent id, for get / put / delete.
        by_id = {
            "clients": ("client", "Client", {"name": "x"}),
            "projects": ("project", "Project", {"name": "x"}),
            "models": ("model", "Model", {"name": "x"}),
            "goals": ("goal", "Goal", {"goal": "x"}),
            "sessions": ("session", "Session", {"notes": "x"}),
            "trackers": ("tracker", "Tracker", {"title": "x"}),
            "invoices": ("invoice", "Invoice", {"notes": "x"}),
        }
        for path, (key, label, body) in by_id.items():
            for doc_id in (ids[key], "does-not-exist"):
                expected = {"detail": f"{label} '{doc_id}' not found."}
                for method, kwargs in (("get", {}), ("put", {"json": body}), ("delete", {})):
                    resp = getattr(c, method)(f"/{path}/{doc_id}", headers=self.b, **kwargs)
                    self.assertEqual(resp.status_code, 404, f"{method} /{path}/{doc_id}")
                    self.assertEqual(resp.json(), expected, f"{method} /{path}/{doc_id}")
        for method, kwargs in (("get", {}), ("put", {"data": {"title": "x"}}), ("delete", {})):
            resp = getattr(c, method)(f"/tasks/{ids['task']}", headers=self.b, **kwargs)
            self.assertEqual(resp.status_code, 404, f"{method} /tasks")

        # Sub-resources hang off the owner check too.
        for method, path, kwargs in (
            ("post", f"/trackers/{ids['tracker']}/tasks", {"json": {"task_ids": []}}),
            ("post", f"/trackers/{ids['tracker']}/time-entries", {"json": {}}),
            ("delete", f"/trackers/{ids['tracker']}/tasks/{ids['task']}", {}),
            ("patch", f"/invoices/{ids['invoice']}/status", {"json": {"status": "void"}}),
            ("post", f"/invoices/{ids['invoice']}/payments",
             {"json": {"paid_on": "2026-10-09", "amount_paid": 1, "amount_received": 1}}),
        ):
            resp = getattr(c, method)(path, headers=self.b, **kwargs)
            self.assertEqual(resp.status_code, 404, f"{method} {path}: {resp.text}")

        # Cross-references from B's own requests to A's documents are 404s.
        b_client = self._ok(c.post("/clients", json={"name": "B Co"}, headers=self.b), 201)["id"]
        b_project = self._ok(c.post("/projects", json={"name": "BP", "client_id": b_client}, headers=self.b), 201)["id"]
        b_task = self._ok(c.post("/tasks", data={"title": "BT", "project_ids": b_project}, headers=self.b), 201)["id"]
        cross = [
            ("post", "/projects", {"json": {"name": "p", "client_id": ids["client"]}}),
            ("put", f"/projects/{b_project}", {"json": {"client_id": ids["client"]}}),
            ("post", "/tasks", {"data": {"title": "t", "project_ids": ids["project"]}}),
            ("post", "/tasks", {"data": {"title": "t", "project_ids": b_project, "parent_task_id": ids["task"]}}),
            ("post", "/tasks/bulk", {"json": {"titles": ["t"], "project_ids": [ids["project"]]}}),
            ("put", f"/tasks/{b_task}", {"data": {"project_ids": ids["project"]}}),
            ("post", "/sessions", {"json": {"task_id": ids["task"], "start_time": "2026-10-05T09:00:00+08:00"}}),
            ("post", "/sessions", {"json": {"task_id": b_task, "start_time": "2026-10-05T09:00:00+08:00",
                                            "tracker_id": ids["tracker"]}}),
            ("post", "/trackers", {"json": {"title": "t", "start_time": "2026-10-05T09:00:00+08:00",
                                            "task_ids": [ids["task"]]}}),
            ("post", "/trackers", {"json": {"title": "t", "start_time": "2026-10-05T09:00:00+08:00",
                                            "new_task": {"project_id": ids["project"]}}}),
            ("post", "/goals", {"data": {"model_id": ids["model"], "goal": "g"}}),
            ("post", "/invoices/preview", {"json": {"client_id": ids["client"], "period_start": "2026-10-01",
                                                    "period_end": "2026-10-31"}}),
            ("post", "/invoices/preview", {"json": {"client_id": b_client, "period_start": "2026-10-01",
                                                    "period_end": "2026-10-31", "for_invoice_id": ids["invoice"]}}),
            ("post", "/invoices", {"json": {"client_id": ids["client"]}}),
            ("post", "/invoices", {"json": {"client_id": b_client, "lines": [{"session_ids": [ids["session"]]}]}}),
            ("post", "/invoices", {"json": {"client_id": b_client, "lines": [{"tracker_id": ids["tracker"]}]}}),
            ("post", "/invoices", {"json": {"client_id": b_client, "lines": [{"task_id": ids["task"]}]}}),
            ("post", "/invoices", {"json": {"client_id": b_client, "project_ids": [ids["project"]]}}),
        ]
        for method, path, kwargs in cross:
            resp = getattr(c, method)(path, headers=self.b, **kwargs)
            self.assertEqual(resp.status_code, 404, f"{method} {path} {kwargs}: {resp.text}")

        # Nothing of A's was modified by any of the above.
        a_session = self.db.data["sessions"][ids["session"]]
        self.assertEqual(a_session["invoice_ids"], [ids["invoice"]])
        self.assertEqual(self.db.data["trackers"][ids["tracker"]]["invoice_ids"], [])
        self.assertEqual(self._ok(c.get(f"/invoices/{ids['invoice']}", headers=self.a))["status"], "draft")

        # Settings and invoice numbering are per user.
        self.assertEqual(self._ok(c.get("/settings/invoice", headers=self.b))["business_name"], "")
        self.assertEqual(self._ok(c.get("/settings/invoice", headers=self.a))["business_name"], "A Corp")
        b_inv = self._ok(c.post("/invoices", json={"client_id": b_client}, headers=self.b), 201)
        self.assertEqual(b_inv["invoice_number"], ids["invoice_number"])  # both start at 001
        self.assertTrue(b_inv["invoice_number"].endswith("-001"))
        a_inv2 = self._ok(c.post("/invoices", json={"client_id": ids["client"]}, headers=self.a), 201)
        self.assertTrue(a_inv2["invoice_number"].endswith("-002"), a_inv2["invoice_number"])
        self.assertEqual(b_inv["issued_by"]["business_name"], "")

    def test_attachments_are_signed_only_for_their_owner(self):
        ids = self._seed_user_a()
        c = self.client

        # Stored: the blob name, never a URL.
        task_att = self.db.data["tasks"][ids["task"]]["attachments"]
        self.assertEqual(task_att, [{"name": "spec.txt", "blob_name": f"sub-A/tasks/{ids['task']}/spec.txt"}])
        goal_att = self.db.data["goals"][ids["goal"]]["attachments"]
        self.assertEqual(goal_att, [{"name": "prompt.md", "blob_name": f"sub-A/goals/{ids['goal']}/prompt.md"}])

        # A gets signed URLs, from both the by-id and the list reads.
        for path, key in ((f"/tasks/{ids['task']}", None), ("/tasks", 0), (f"/goals/{ids['goal']}", None), ("/goals", 0)):
            body = self._ok(c.get(path, headers=self.a))
            doc = body[key] if key is not None else body
            [att] = doc["attachments"]
            self.assertIn("X-Goog-Signature=", att["gcs_url"], path)
            self.assertTrue(att["gcs_url"].startswith("https://storage.googleapis.com/test-bucket/sub-A/"), path)
            self.assertNotIn("blob_name", att)

        # B can get no signature for A's attachments by any route.
        self.signed.clear()
        for method, path, kwargs in (
            ("get", f"/tasks/{ids['task']}", {}), ("get", f"/goals/{ids['goal']}", {}),
            ("put", f"/tasks/{ids['task']}", {"data": {"title": "x"}}),
            ("put", f"/goals/{ids['goal']}", {"json": {"goal": "x"}}),
        ):
            self.assertEqual(getattr(c, method)(path, headers=self.b, **kwargs).status_code, 404, path)
        for path in ("/tasks", "/goals", f"/goals?task_id={ids['task']}"):
            self.assertEqual(self._ok(c.get(path, headers=self.b)), [], path)
        self.assertEqual(self.signed, [])

        # A legacy entry (public URL only) is derived to its blob name and
        # signed; one pointing outside the task's folder or bucket is refused.
        self.db.data["tasks"][ids["task"]]["attachments"] = [
            {"name": "old.txt", "gcs_url": f"https://storage.googleapis.com/test-bucket/tasks/{ids['task']}/old file.txt"},
            {"name": "evil", "gcs_url": "https://storage.googleapis.com/test-bucket/sub-B/tasks/x/secret.txt"},
            {"name": "evil2", "blob_name": f"sub-A/tasks/{ids['task']}/../../../sub-B/x"},
            {"name": "other", "gcs_url": f"https://storage.googleapis.com/other-bucket/tasks/{ids['task']}/x"},
        ]
        atts = self._ok(c.get(f"/tasks/{ids['task']}", headers=self.a))["attachments"]
        self.assertEqual([a["name"] for a in atts], ["old.txt", "evil", "evil2", "other"])
        self.assertIn("X-Goog-Signature=", atts[0]["gcs_url"])
        self.assertEqual([a["gcs_url"] for a in atts[1:]], [None, None, None])
        self.assertEqual(self.signed, [f"tasks/{ids['task']}/old file.txt"])

        # B cannot delete A's task (or its blobs); A's delete removes exactly its blobs.
        self.assertEqual(c.delete(f"/tasks/{ids['task']}", headers=self.b).status_code, 404)
        self.assertEqual(c.delete(f"/goals/{ids['goal']}", headers=self.b).status_code, 404)
        self.assertEqual(self.deleted, [])
        self.assertEqual(c.delete(f"/tasks/{ids['task']}", headers=self.a).status_code, 204)
        self.assertEqual(c.delete(f"/goals/{ids['goal']}", headers=self.a).status_code, 204)
        self.assertEqual(self.deleted, [
            f"tasks/{ids['task']}/old file.txt", f"sub-A/goals/{ids['goal']}/prompt.md",
        ])

    def test_signing_failure_does_not_fail_the_list(self):
        ids = self._seed_user_a()

        def boom(name):
            raise RuntimeError("iam.serviceAccounts.signBlob denied")

        with mock.patch("services.storage_service.generate_signed_url", boom), \
                self.assertLogs("services.storage_service", "WARNING"):
            tasks = self._ok(self.client.get("/tasks", headers=self.a))
        self.assertEqual(tasks[0]["id"], ids["task"])
        self.assertEqual(tasks[0]["attachments"], [{"name": "spec.txt", "gcs_url": None}])

    def test_legacy_documents_without_owner_are_invisible(self):
        c = self.client
        self.db.collection("clients").document("legacy1").set({"name": "Old"})
        self.db.collection("settings").document("invoice").set({"business_name": "Legacy Corp"})
        for headers in (self.a, self.b):
            self.assertEqual(self._ok(c.get("/clients", headers=headers)), [])
            self.assertEqual(c.get("/clients/legacy1", headers=headers).status_code, 404)
            self.assertEqual(self._ok(c.get("/settings/invoice", headers=headers))["business_name"], "")

    def test_token_without_sub_is_rejected(self):
        resp = self.client.get("/clients", headers={"Authorization": f"Bearer {_token(None)}"})
        self.assertEqual(resp.status_code, 401, resp.text)


class StorageSigningTest(unittest.TestCase):
    def setUp(self):
        from services import storage_service as ss

        self.ss = ss
        ss._url_cache.clear()
        ss._credentials, ss._credentials_error = None, None
        self.addCleanup(ss._url_cache.clear)
        self.addCleanup(setattr, ss, "_credentials", None)
        self.addCleanup(setattr, ss, "_credentials_error", None)

    def test_blob_name_from_url(self):
        f = self.ss.blob_name_from_url
        self.assertEqual(f("https://storage.googleapis.com/b/tasks/1/a b.txt", "b"), "tasks/1/a b.txt")
        self.assertEqual(f("https://storage.googleapis.com/b/tasks/1/a%20b.txt", "b"), "tasks/1/a b.txt")
        self.assertEqual(f("https://storage.googleapis.com/b/tasks/1/100% done.txt", "b"), "tasks/1/100% done.txt")
        self.assertEqual(f("https://b.storage.googleapis.com/goals/2/x.md", "b"), "goals/2/x.md")
        self.assertEqual(f("gs://b/goals/2/x.md", "b"), "goals/2/x.md")
        self.assertIsNone(f("https://storage.googleapis.com/other/tasks/1/x", "b"))
        self.assertIsNone(f("https://evil.example/b/tasks/1/x", "b"))
        self.assertIsNone(f("", "b"))

    def _creds(self, email, token="tok"):
        creds = mock.Mock(valid=False, token=token, service_account_email=email)
        creds.refresh.side_effect = lambda req: setattr(creds, "valid", True)
        return creds

    def test_iam_signing_uses_runtime_service_account_and_caches(self):
        creds = self._creds("runtime@p.iam.gserviceaccount.com")
        blob = mock.Mock()
        blob.generate_signed_url.return_value = "https://signed/1"
        client = mock.Mock()
        client.bucket.return_value.blob.return_value = blob
        with mock.patch("google.auth.default", return_value=(creds, "p")) as default, \
                mock.patch.object(self.ss, "get_storage_client", return_value=client):
            self.assertEqual(self.ss.generate_signed_url("sub-A/tasks/1/x"), "https://signed/1")
            self.assertEqual(self.ss.generate_signed_url("sub-A/tasks/1/x"), "https://signed/1")
        default.assert_called_once()
        creds.refresh.assert_called_once()
        blob.generate_signed_url.assert_called_once()
        kwargs = blob.generate_signed_url.call_args.kwargs
        self.assertEqual(kwargs["version"], "v4")
        self.assertEqual(kwargs["method"], "GET")
        self.assertEqual(kwargs["service_account_email"], "runtime@p.iam.gserviceaccount.com")
        self.assertEqual(kwargs["access_token"], "tok")

    def test_user_credentials_without_service_account_fail_clearly(self):
        creds = self._creds(None)
        del creds.service_account_email
        with mock.patch("google.auth.default", return_value=(creds, "p")), \
                mock.patch.dict(os.environ, {"GCS_SIGNING_SERVICE_ACCOUNT": ""}):
            with self.assertRaisesRegex(self.ss.SigningUnavailable, "GCS_SIGNING_SERVICE_ACCOUNT"):
                self.ss._signing_kwargs()
        with mock.patch("google.auth.default", return_value=(creds, "p")), \
                mock.patch.dict(os.environ, {"GCS_SIGNING_SERVICE_ACCOUNT": "dev@p.iam.gserviceaccount.com"}):
            self.assertEqual(self.ss._signing_kwargs()["service_account_email"], "dev@p.iam.gserviceaccount.com")


class BackfillPlanTest(unittest.TestCase):
    def test_plan_settings(self):
        from scripts.backfill_owner_id import needs_owner, plan_settings

        self.assertTrue(needs_owner({}))
        self.assertTrue(needs_owner({"owner_id": ""}))
        self.assertFalse(needs_owner({"owner_id": "x"}))

        copies, notes = plan_settings(
            {"invoice": {"business_name": "B"}, "invoice_counter": {"year": 2026, "seq": 7},
             "tracker_S": {"owner_id": "S"}, "tracker": {"auto_name_enabled": False}},
            "S",
        )
        self.assertEqual(
            sorted(copies),
            [("invoice_S", {"business_name": "B", "owner_id": "S"}),
             ("invoice_counter_S", {"year": 2026, "seq": 7, "owner_id": "S"})],
        )
        self.assertTrue(any("tracker_S already exists" in n for n in notes))


if __name__ == "__main__":
    unittest.main()
