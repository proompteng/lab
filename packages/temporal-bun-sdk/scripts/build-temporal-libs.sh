#!/bin/bash
set -e

VENDOR_DIR="vendor/temporal-sdk-core"
VERSION="v1.0.0"

cd "$(dirname "$0")/.."

if [ ! -d "$VENDOR_DIR" ]; then
  echo "📥 Cloning temporal-sdk-core..."
  mkdir -p vendor
  git clone --depth 1 https://github.com/temporalio/sdk-core.git "$VENDOR_DIR"
fi

echo "🔨 Building temporal-sdk-core for current platform..."
cd "$VENDOR_DIR"
cargo build --release

echo "📦 Packaging libraries..."
cd ../..
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

[ "$PLATFORM" = "darwin" ] && PLATFORM="macos"
[ "$ARCH" = "x86_64" ] && ARCH="x64"
[ "$ARCH" = "aarch64" ] && ARCH="arm64"

RELEASE_DIR="releases/$VERSION/$PLATFORM-$ARCH"
mkdir -p "$RELEASE_DIR"

find "$VENDOR_DIR/target/release" -name "*.a" -exec cp {} "$RELEASE_DIR/" \;

TARBALL="releases/temporal-static-libs-$PLATFORM-$ARCH-$VERSION.tar.gz"
tar -czf "$TARBALL" -C "$RELEASE_DIR" .

shasum -a 256 "$TARBALL" | awk '{print $1 "  " $2}' | sed 's|releases/||' > "$TARBALL.sha256"

echo "✅ Built: $TARBALL"
echo "📤 Upload with: gh release upload temporal-libs-$VERSION $TARBALL $TARBALL.sha256 --clobber"
