#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: verify-headlamp-image-assets <nix-image-tar>" >&2
  exit 2
fi

image_tar="$1"
if [[ ! -f "$image_tar" ]]; then
  echo "Headlamp image archive does not exist: $image_tar" >&2
  exit 1
fi

verification_dir="$(mktemp -d)"
cleanup() {
  chmod -R u+w "$verification_dir" 2>/dev/null || true
  rm -rf "$verification_dir"
}
trap cleanup EXIT
archive_dir="$verification_dir/archive"
rootfs_dir="$verification_dir/rootfs"
mkdir -p "$archive_dir" "$rootfs_dir"

tar -xf "$image_tar" -C "$archive_dir"
manifest_path="$archive_dir/manifest.json"
if [[ ! -f "$manifest_path" ]]; then
  echo "Headlamp image archive is missing manifest.json" >&2
  exit 1
fi

image_layers=()
while IFS= read -r image_layer; do
  image_layers+=("$image_layer")
done < <(jq -r '.[0].Layers[]' "$manifest_path")
if [[ "${#image_layers[@]}" -eq 0 ]]; then
  echo "Headlamp image archive contains no layers" >&2
  exit 1
fi

for image_layer in "${image_layers[@]}"; do
  layer_path="$archive_dir/$image_layer"
  if [[ ! -f "$layer_path" ]]; then
    echo "Headlamp image layer is missing: $image_layer" >&2
    exit 1
  fi
  tar -xf "$layer_path" -C "$rootfs_dir"
done

headlamp_root="$rootfs_dir/headlamp"
frontend_root="$headlamp_root/frontend"
index_path="$frontend_root/index.html"
if [[ -L "$headlamp_root" || -L "$frontend_root" || -L "$index_path" ]]; then
  echo "Headlamp runtime root, frontend root, and index must be materialized files and directories" >&2
  exit 1
fi
if [[ ! -f "$index_path" ]]; then
  echo "Headlamp image is missing /headlamp/frontend/index.html" >&2
  exit 1
fi

remaining_link="$(find "$headlamp_root" -type l -print -quit)"
if [[ -n "$remaining_link" ]]; then
  echo "Headlamp image contains a store-backed runtime symlink: ${remaining_link#"$rootfs_dir"}" >&2
  exit 1
fi

asset_refs=()
while IFS= read -r asset_ref; do
  asset_refs+=("$asset_ref")
done < <(
  grep -Eo '(src|href)="/assets/[^"]+"' "$index_path" \
    | sed -E 's/^(src|href)="([^"]+)"$/\2/' \
    | sort -u
)
if [[ "${#asset_refs[@]}" -eq 0 ]]; then
  echo "Headlamp index does not reference any /assets files" >&2
  exit 1
fi

javascript_assets=0
stylesheet_assets=0
for asset_ref in "${asset_refs[@]}"; do
  asset_path="${asset_ref%%[?#]*}"
  materialized_asset="$frontend_root/${asset_path#/}"
  if [[ -L "$materialized_asset" || ! -f "$materialized_asset" || ! -r "$materialized_asset" ]]; then
    echo "Headlamp index references a missing, unreadable, or symlinked asset: $asset_ref" >&2
    exit 1
  fi
  case "$asset_path" in
    *.js) javascript_assets=$((javascript_assets + 1)) ;;
    *.css) stylesheet_assets=$((stylesheet_assets + 1)) ;;
  esac
done

if [[ "$javascript_assets" -eq 0 || "$stylesheet_assets" -eq 0 ]]; then
  echo "Headlamp index must reference materialized JavaScript and stylesheet assets" >&2
  exit 1
fi

printf 'Verified %d Headlamp frontend assets (%d JavaScript, %d stylesheet) with no runtime symlinks.\n' \
  "${#asset_refs[@]}" "$javascript_assets" "$stylesheet_assets"
