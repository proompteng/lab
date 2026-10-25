#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: inspect-oci-archive <nix-image-tar>" >&2
  exit 2
fi

image_tar="$1"
if [[ ! -f "${image_tar}" ]]; then
  echo "Image archive does not exist: ${image_tar}" >&2
  exit 1
fi

resolved_image_tar="$(readlink -f "${image_tar}")"
if [[ "${resolved_image_tar}" != /nix/store/* ]]; then
  echo "Refusing to inspect a non-Nix-store image archive: ${resolved_image_tar}" >&2
  exit 1
fi

inspect_json="$(mktemp)"
trap 'rm -f "${inspect_json}"' EXIT

skopeo inspect "docker-archive:${resolved_image_tar}" > "${inspect_json}"
jq -e '(.Architecture | type == "string" and length > 0) and (.Os | type == "string" and length > 0)' \
  "${inspect_json}" >/dev/null
jq '{name:(.Name // null), digest:(.Digest // null), os:.Os, architecture:.Architecture, tags:(.RepoTags // [])}' \
  "${inspect_json}"
