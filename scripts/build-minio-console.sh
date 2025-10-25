#!/bin/bash
set -euo pipefail

IMAGE_NAME="registry.ide-newton.ts.net/lab/minio-console"
DOCKERFILE="containers/minio-console/Dockerfile"
CONTEXT_PATH="."

TAG="${1:-$(git rev-parse --short HEAD)}"
MINIO_CONSOLE_VERSION="${MINIO_CONSOLE_VERSION:-v2.0.4}"
FULL_IMAGE_NAME="${IMAGE_NAME}:${TAG}"

echo "[minio-console] Building ${FULL_IMAGE_NAME} (console ${MINIO_CONSOLE_VERSION})"
docker buildx build \
  --platform linux/amd64 \
  --file "${DOCKERFILE}" \
  --tag "${FULL_IMAGE_NAME}" \
  --build-arg MINIO_CONSOLE_VERSION="${MINIO_CONSOLE_VERSION}" \
  "${CONTEXT_PATH}" \
  --push

echo "[minio-console] Image published: ${FULL_IMAGE_NAME}"
