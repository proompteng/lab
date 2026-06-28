#!/usr/bin/env bash
set -euo pipefail

image="${ATTIC_IMAGE:-registry.ide-newton.ts.net/lab/attic}"
event_name="${EVENT_NAME:-}"
workflow_run_head_sha="${WORKFLOW_RUN_HEAD_SHA:-}"
commit_sha_input="${COMMIT_SHA_INPUT:-}"
image_tag_input="${IMAGE_TAG_INPUT:-}"
image_digest_input="${IMAGE_DIGEST_INPUT:-}"

if [[ -z "${event_name}" ]]; then
  echo "EVENT_NAME is required" >&2
  exit 2
fi

main_head="$(git rev-parse origin/main)"
source_sha="${commit_sha_input}"
tag="${image_tag_input}"
digest="${image_digest_input}"
promote='true'

if [[ "${event_name}" == 'workflow_run' ]]; then
  contract='.artifacts/attic/release-contract.json'
  test -f "${contract}"

  contract_image="$(jq -r '.image' "${contract}")"
  source_sha="$(jq -r '.sourceSha' "${contract}")"
  tag="$(jq -r '.tag' "${contract}")"
  digest="$(jq -r '.digest' "${contract}")"
  builder="$(jq -r '.builder' "${contract}")"

  if [[ "${contract_image}" != "${image}" ]]; then
    echo "Release contract image mismatch: expected ${image}, got ${contract_image}" >&2
    exit 1
  fi
  if [[ "${builder}" != 'nix-dockerTools-skopeo' ]]; then
    echo "Release contract was not produced by the Nix OCI builder: ${builder}" >&2
    exit 1
  fi
  if [[ "${source_sha}" != "${workflow_run_head_sha}" ]]; then
    echo "Release contract source SHA ${source_sha} does not match workflow_run head ${workflow_run_head_sha}" >&2
    exit 1
  fi
else
  if [[ -z "${source_sha}" ]]; then
    source_sha="${main_head}"
  else
    source_sha="$(git rev-parse "${source_sha}^{commit}")"
  fi
  if [[ -z "${tag}" ]]; then
    tag="sha-$(git rev-parse --short=12 "${source_sha}")"
  fi
  if [[ -z "${digest}" ]]; then
    digest="$(crane digest "${image}:${tag}")"
  fi
fi

if [[ "${source_sha}" != "${main_head}" ]]; then
  if ! git merge-base --is-ancestor "${source_sha}" "${main_head}"; then
    echo "Skipping stale Attic promotion for ${source_sha}; latest main ${main_head} is not a descendant."
    promote='false'
  else
    changed="$(
      git diff --name-only "${source_sha}..${main_head}" -- \
        flake.nix \
        flake.lock \
        nix \
        argocd/applications/attic \
        .github/workflows/attic-build-push.yaml \
        .github/workflows/attic-release.yml \
        .github/workflows/nix-oci-build-common.yml
    )"
    if [[ -n "${changed}" ]]; then
      echo "Skipping stale Attic promotion for ${source_sha}; newer Attic build inputs changed:"
      printf '%s\n' "${changed}"
      promote='false'
    fi
  fi
fi

digest="${digest#*@}"
if [[ "${promote}" == 'true' ]] && ! printf '%s' "${digest}" | grep -Eiq '^sha256:[0-9a-f]{64}$'; then
  echo "Resolved digest '${digest}' is invalid" >&2
  exit 1
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "main_head=${main_head}"
    echo "source_sha=${source_sha}"
    echo "tag=${tag}"
    echo "digest=${digest}"
    echo "image=${image}"
    echo "promote=${promote}"
  } >> "${GITHUB_OUTPUT}"
fi

cat <<EOF
main_head=${main_head}
source_sha=${source_sha}
tag=${tag}
digest=${digest}
image=${image}
promote=${promote}
EOF
