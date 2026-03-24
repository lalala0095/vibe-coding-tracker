import os
from google.cloud import firestore

_client: firestore.Client | None = None


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
