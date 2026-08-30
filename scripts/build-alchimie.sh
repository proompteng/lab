#!/bin/bash

# Set variables
IMAGE_NAME="registry.ide-newton.ts.net/lab/alchimie"
DOCKERFILE="apps/alchimie/Dockerfile"
CONTEXT_PATH="apps/alchimie"
DAGSTER_VERSION="1.10.6"

# Process command line arguments
while [[ $# -gt 0 ]]; do
    key="$1"
    case $key in
        -v|--version)
            DAGSTER_VERSION="$2"
            shift 2
            ;;
        -t|--tag)
            TAG="$2"
            shift 2
            ;;
        *)
            # Unknown option
            echo "Unknown option: $1"
            echo "Usage: $0 [-v|--version VERSION] [-t|--tag TAG]"
            exit 1
            ;;
    esac
done

# Check if a tag is provided as an argument
if [ -z "${TAG}" ]; then
    # If no tag is provided, use the current date and time
    TAG=$(date +"%Y%m%d_%H%M%S")
fi

# Full image name with tag
FULL_IMAGE_NAME="${IMAGE_NAME}:${TAG}"

# Build the Docker image
echo "========================================="
echo "Building $FULL_IMAGE_NAME"
echo "Dagster version: $DAGSTER_VERSION"
echo "Platform: ARM64"
echo "========================================="

if docker buildx build --platform linux/arm64 \
    --build-arg DAGSTER_VERSION="${DAGSTER_VERSION}" \
    -t "${FULL_IMAGE_NAME}" \
    -f "${DOCKERFILE}" "${CONTEXT_PATH}" --push; then
    echo "Docker image built and pushed successfully: ${FULL_IMAGE_NAME}"
else
    echo "Docker image build or push failed"
    exit 1
fi
