#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: oci-push --image <registry/repo> --tag <tag> --tar <nix-image-tar> \
  --source-sha <full commit sha> --source-timestamp <RFC3339 timestamp> [--latest-tag <tag>]

Pushes a Nix-built dockerTools image tarball to an OCI registry without Docker.
EOF
}

image=""
tag=""
tar_path=""
latest_tag=""
source_sha=""
source_timestamp=""

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
    --source-sha)
      source_sha="${2:-}"
      shift 2
      ;;
    --source-timestamp)
      source_timestamp="${2:-}"
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

if [[ -z "${image}" || -z "${tag}" || -z "${tar_path}" || -z "${source_sha}" || -z "${source_timestamp}" ]]; then
  usage
  exit 2
fi

if [[ ! "${source_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Source commit SHA must be a full lowercase 40-hex commit SHA: ${source_sha}" >&2
  exit 2
fi

if [[ ! "${source_timestamp}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
  echo "Source commit timestamp must be RFC3339: ${source_timestamp}" >&2
  exit 2
fi

if ! git cat-file -e "${source_sha}^{commit}" 2>/dev/null; then
  echo "Source commit is not present in the checkout: ${source_sha}" >&2
  exit 1
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

echo "Stamping ${reference} with source commit provenance."
crane mutate "${reference}" \
  --label "org.opencontainers.image.created=${source_timestamp}" \
  --label "org.opencontainers.image.revision=${source_sha}" \
  --tag "${reference}" >/dev/null

config="$(crane config "${reference}")"
jq -e \
  --arg source_timestamp "${source_timestamp}" \
  --arg source_sha "${source_sha}" \
  '.config.Labels["org.opencontainers.image.created"] == $source_timestamp and
   .config.Labels["org.opencontainers.image.revision"] == $source_sha' \
  <<<"${config}" >/dev/null

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
