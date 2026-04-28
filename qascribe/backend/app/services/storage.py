"""S3-compatible storage (MinIO locally, AWS S3 in prod)."""
import logging
from pathlib import Path
import boto3
from botocore.client import Config

from app.core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class StorageService:
    def __init__(self):
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT_URL,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            config=Config(signature_version="s3v4"),
        )
        self.bucket = settings.S3_BUCKET
        self._ensure_bucket()

    def _ensure_bucket(self) -> None:
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except self.client.exceptions.ClientError:
            self.client.create_bucket(Bucket=self.bucket)

    def upload_file(self, local_path: str | Path, key: str) -> str:
        self.client.upload_file(str(local_path), self.bucket, key)
        return key

    def download_file(self, key: str, local_path: str | Path) -> Path:
        self.client.download_file(self.bucket, key, str(local_path))
        return Path(local_path)

    def get_presigned_url(self, key: str, expires_in: int = 3600) -> str:
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=expires_in,
        )
