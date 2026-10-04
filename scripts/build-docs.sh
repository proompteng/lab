#!/bin/bash

# Set variables
IMAGE_NAME="registry.ide-newton.ts.net/lab/docs"
DOCKERFILE="apps/docs/Dockerfile"
CONTEXT_PATH="."

# Check if a tag is provided as an argument
if [ $# -eq 1 ]; then
    TAG=$1
else
    # If no tag is provided, use the current date and time
    TAG=$(date +"%Y%m%d_%H%M%S")
fi

# Full image name with tag
FULL_IMAGE_NAME="${IMAGE_NAME}:${TAG}"

# Determine whether to push or load locally
build_cmd=(docker buildx build -t "${FULL_IMAGE_NAME}" -f "${DOCKERFILE}" "${CONTEXT_PATH}")

if [ "${SKIP_PUSH:-0}" = "1" ]; then
    echo "Building Docker image locally without pushing (SKIP_PUSH=1)."
    build_cmd+=(--load)
else
    echo "Building and pushing Docker image: ${FULL_IMAGE_NAME}"
    build_cmd+=(--platform linux/arm64 --push)
fi

if "${build_cmd[@]}"; then
    if [ "${SKIP_PUSH:-0}" = "1" ]; then
        echo "Docker image built and loaded locally: ${FULL_IMAGE_NAME}"
    else
        echo "Docker image built and pushed successfully: ${FULL_IMAGE_NAME}"
    fi
else
    echo "Docker image build or push failed"
    exit 1
fi
