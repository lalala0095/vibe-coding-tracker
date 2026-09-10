import os
from google.cloud import storage

_client: storage.Client | None = None


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


def upload_file(
    file_bytes: bytes,
    destination_blob_name: str,
    content_type: str,
) -> str:
    """
    Upload bytes to GCS and return the public URL.

    Assumes the bucket is configured for uniform public access (allUsers has
    roles/storage.objectViewer, or the bucket is public).

    Args:
        file_bytes: Raw file content.
        destination_blob_name: Full path inside the bucket, e.g.
            ``goals/<goal_id>/<filename>``.
        content_type: MIME type of the file.

    Returns:
        Public URL of the uploaded object.
    """
    client = get_storage_client()
    bucket_name = get_bucket_name()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(destination_blob_name)

    blob.upload_from_string(file_bytes, content_type=content_type)

    public_url = f"https://storage.googleapis.com/{bucket_name}/{destination_blob_name}"
    return public_url


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
