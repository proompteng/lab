"""Runtime build metadata exposed by Torghut API payloads."""

import os

BUILD_VERSION = os.getenv("TORGHUT_VERSION", "dev")
BUILD_COMMIT = os.getenv("TORGHUT_COMMIT", "unknown")
BUILD_IMAGE_DIGEST = os.getenv("TORGHUT_IMAGE_DIGEST", "").strip() or None
BUILD_SOURCE_CI_REF = os.getenv("TORGHUT_SOURCE_CI_REF", "").strip() or None
BUILD_MANIFEST_COMMIT = os.getenv("TORGHUT_MANIFEST_COMMIT", "").strip() or None
BUILD_MANIFEST_IMAGE_DIGEST = (
    os.getenv("TORGHUT_MANIFEST_IMAGE_DIGEST", "").strip() or BUILD_IMAGE_DIGEST
)
BUILD_ARGO_SYNC_REVISION = os.getenv("TORGHUT_ARGO_SYNC_REVISION", "").strip() or None
BUILD_ARGO_HEALTH = os.getenv("TORGHUT_ARGO_HEALTH", "").strip() or None

__all__ = (
    "BUILD_VERSION",
    "BUILD_COMMIT",
    "BUILD_IMAGE_DIGEST",
    "BUILD_SOURCE_CI_REF",
    "BUILD_MANIFEST_COMMIT",
    "BUILD_MANIFEST_IMAGE_DIGEST",
    "BUILD_ARGO_SYNC_REVISION",
    "BUILD_ARGO_HEALTH",
)
