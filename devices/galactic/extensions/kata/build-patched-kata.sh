#!/usr/bin/env bash

set -euo pipefail

readonly KATA_SOURCE_COMMIT='894e1956bb340752b30f7ad49879972234a0098c'

usage() {
  echo "usage: $0 <kata-source-dir> <output-dir>" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir
source_dir="$(cd -- "$1" && pwd -P)"
readonly source_dir
readonly requested_output_dir="$2"
readonly patch_file="$script_dir/patches/0001-persistent-block-automount.patch"

for command in cargo docker git make tar yq zstd; do
  if ! command -v "$command" >/dev/null; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

if [[ "$(git -C "$source_dir" rev-parse HEAD)" != "$KATA_SOURCE_COMMIT" ]]; then
  echo "Kata source must be pinned to $KATA_SOURCE_COMMIT" >&2
  exit 1
fi
if [[ -n "$(git -C "$source_dir" status --porcelain)" ]]; then
  echo 'Kata source checkout must be clean before applying the reviewed patch' >&2
  exit 1
fi

git -C "$source_dir" apply --unidiff-zero --check "$patch_file"
git -C "$source_dir" apply --unidiff-zero "$patch_file"
make -C "$source_dir/src/agent" src/version.rs

(
  cd -- "$source_dir"
  cargo test --locked -p kata-agent storage::block_handler::tests
  cargo test --locked -p runtimes container_manager::container::tests
)

install -d "$requested_output_dir"
output_dir="$(cd -- "$requested_output_dir" && pwd -P)"
readonly output_dir
readonly build_dir="$source_dir/tools/packaging/kata-deploy/local-build/build"
readonly component_builder="$source_dir/tools/packaging/kata-deploy/local-build/kata-deploy-binaries.sh"

# The upstream Make targets first build a general-purpose Docker wrapper just
# to bootstrap yq, oras, and the Docker CLI. CI already provides those tools,
# and cache pulls are intentionally disabled for this patched source, so invoke
# the same upstream per-component builder directly. The agent and shim still
# build inside Kata's pinned, architecture-native builder images.
"$source_dir/tools/packaging/kata-deploy/local-build/kata-deploy-copy-libseccomp-installer.sh" agent
(
  cd -- "$source_dir/tools/packaging/kata-deploy/local-build"
  USE_CACHE=no PUSH_TO_REGISTRY=no "$component_builder" --build=agent
  USE_CACHE=no PUSH_TO_REGISTRY=no RUNTIME_CHOICE=rust "$component_builder" --build=shim-v2-rust
)

for artifact in kata-static-agent.tar.zst kata-static-shim-v2-rust.tar.zst; do
  if [[ ! -s "$build_dir/$artifact" ]]; then
    echo "Kata build did not produce $artifact" >&2
    exit 1
  fi
  install -m 0644 "$build_dir/$artifact" "$output_dir/$artifact"
done

tar --zstd -tf "$output_dir/kata-static-agent.tar.zst" \
  | grep -Fxq './usr/bin/kata-agent'
tar --zstd -tf "$output_dir/kata-static-shim-v2-rust.tar.zst" \
  | grep -Fxq './opt/kata/runtime-rs/bin/containerd-shim-kata-v2'

sha256sum "$output_dir"/*.tar.zst
