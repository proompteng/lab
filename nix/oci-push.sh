#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: oci-push --image <registry/repo> --tag <tag> --tar <nix-image-tar> [--latest-tag <tag>]

Pushes a Nix-built dockerTools image tarball to an OCI registry without Docker.
EOF
}

image=""
tag=""
tar_path=""
latest_tag=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --image)
      image="${2:-}"
      shift 2
      ;;
    --tag)
      tag="${2:-}"
      shift 2
      ;;
    --tar)
      tar_path="${2:-}"
      shift 2
      ;;
    --latest-tag)
      latest_tag="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "${image}" || -z "${tag}" || -z "${tar_path}" ]]; then
  usage
  exit 2
fi

if [[ ! -f "${tar_path}" ]]; then
  echo "Nix image tar path must be a file: ${tar_path}" >&2
  exit 1
fi

resolved_tar_path="$(readlink -f "${tar_path}")"
if [[ "${resolved_tar_path}" != /nix/store/* ]]; then
  echo "Refusing to push a non-Nix-store image tar: ${resolved_tar_path}" >&2
  exit 1
fi

if [[ "${image}" != registry.ide-newton.ts.net/lab/* ]]; then
  echo "Refusing to push outside lab registry namespace: ${image}" >&2
  exit 1
fi

policy_json="$(mktemp)"
trap 'rm -f "${policy_json}"' EXIT
cat > "${policy_json}" <<'EOF'
{
  "default": [
    {
      "type": "insecureAcceptAnything"
    }
  ]
}
EOF

reference="${image}:${tag}"
echo "Pushing Nix-built OCI image tar to ${reference}."
# The lab registry deliberately admits one shaped bulk writer. Keep each publisher
# to one layer so concurrent releases queue images fairly instead of six layers each.
# dockerTools archives contain uncompressed layers; precompute their destination
# digests so Skopeo can skip blobs already present instead of uploading them again.
skopeo --policy "${policy_json}" copy --dest-precompute-digests \
  --image-parallel-copies 1 --format oci \
  "docker-archive:${resolved_tar_path}" "docker://${reference}"

if [[ -n "${latest_tag}" ]]; then
  latest_reference="${image}:${latest_tag}"
  echo "Tagging ${reference} as ${latest_reference}."
  crane tag "${reference}" "${latest_tag}"
fi

digest="$(crane digest "${reference}")"
echo "Pushed ${reference}@${digest}."

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "image=${image}"
    echo "tag=${tag}"
    echo "digest=${digest}"
    echo "reference=${image}@${digest}"
  } >> "${GITHUB_OUTPUT}"
fi
