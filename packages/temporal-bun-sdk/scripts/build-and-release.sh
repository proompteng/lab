#!/bin/bash
set -e

VERSION="${1:-v1.0.0}"
TAG="temporal-libs-${VERSION}"
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Normalize platform names
if [ "$PLATFORM" = "darwin" ]; then
  PLATFORM="macos"
fi

if [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
elif [ "$ARCH" = "aarch64" ]; then
  ARCH="arm64"
fi

PLATFORM_ARCH="${PLATFORM}-${ARCH}"

echo "🔨 Building temporal libraries for ${PLATFORM_ARCH}"
echo "Version: ${VERSION}"

# Check if we have cached libraries
CACHE_DIR=".temporal-libs-cache"
if [ -d "$CACHE_DIR" ] && [ "$(find "$CACHE_DIR" -name '*.a' | wc -l)" -gt 0 ]; then
  echo "✓ Found cached libraries"
  LIB_DIR="$CACHE_DIR"
else
  echo "✗ No cached libraries found"
  echo "You need to either:"
  echo "  1. Build from Rust source (requires temporal-sdk-core)"
  echo "  2. Download from another source"
  exit 1
fi

# Create release directory
RELEASE_DIR="releases/${VERSION}/${PLATFORM_ARCH}"
mkdir -p "$RELEASE_DIR"

# Copy libraries
echo "📋 Copying libraries..."
find "$LIB_DIR" -name '*.a' -exec cp {} "$RELEASE_DIR/" \;

LIB_COUNT=$(find "$RELEASE_DIR" -name '*.a' -type f | wc -l)
echo "✓ Copied ${LIB_COUNT} libraries"

# Create tarball
TARBALL="temporal-static-libs-${PLATFORM_ARCH}-${VERSION}.tar.gz"
TARBALL_PATH="releases/${TARBALL}"

echo "📦 Creating tarball: ${TARBALL}"
tar -czf "$TARBALL_PATH" -C "$RELEASE_DIR" .

# Calculate checksum
echo "🔐 Calculating checksum..."
CHECKSUM=$(shasum -a 256 "$TARBALL_PATH" | awk '{print $1}')
echo "${CHECKSUM}  ${TARBALL}" > "${TARBALL_PATH}.sha256"
echo "✓ Checksum: ${CHECKSUM}"

# Upload to release
echo "🚀 Uploading to release: ${TAG}"
gh release upload "$TAG" "$TARBALL_PATH" "${TARBALL_PATH}.sha256"

echo "✅ Upload complete!"
echo "To publish the release:"
echo "  gh release edit ${TAG} --draft=false"
