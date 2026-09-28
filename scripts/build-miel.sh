#!/bin/bash

set -euo pipefail

IMAGE_NAME="registry.ide-newton.ts.net/lab/miel"
DOCKERFILE="services/miel/Dockerfile"
CONTEXT_PATH="."

if [ $# -eq 1 ]; then
  TAG=$1
else
  TAG=$(date +"%Y%m%d_%H%M%S")
fi

FULL_IMAGE_NAME="${IMAGE_NAME}:${TAG}"

echo "Building and pushing ${FULL_IMAGE_NAME}"

docker buildx build \
  --platform linux/arm64 \
  -t "${FULL_IMAGE_NAME}" \
  -f "${DOCKERFILE}" \
  "${CONTEXT_PATH}" \
  --push

echo "Image pushed: ${FULL_IMAGE_NAME}"
