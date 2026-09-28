#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${1:-${ROOT_DIR}/charts/agents}"
PACKAGE_API_URL="${ARTIFACTHUB_PACKAGE_API_URL:-https://artifacthub.io/api/v1/packages/helm/agents/agents}"
TIMEOUT_SECONDS="${ARTIFACTHUB_WAIT_TIMEOUT_SECONDS:-2700}"
INTERVAL_SECONDS="${ARTIFACTHUB_WAIT_INTERVAL_SECONDS:-60}"

if [[ ! -f "${CHART_DIR}/Chart.yaml" ]]; then
  echo "Chart.yaml not found in ${CHART_DIR}" >&2
  exit 1
fi

chart_version="$(awk -F': *' '$1 == "version" {print $2; exit}' "${CHART_DIR}/Chart.yaml" | sed "s/[\"']//g")"
chart_license="$(awk -F': *' '$1 == "  artifacthub.io/license" {print $2; exit}' "${CHART_DIR}/Chart.yaml" | sed "s/[\"']//g")"

if [[ -z "${chart_version}" ]]; then
  echo "Unable to detect chart version from ${CHART_DIR}/Chart.yaml" >&2
  exit 1
fi

deadline=$((SECONDS + TIMEOUT_SECONDS))
version_url="${PACKAGE_API_URL}/${chart_version}"

echo "Waiting for Artifact Hub package ${PACKAGE_API_URL} to index version ${chart_version}"

while true; do
  body="$(mktemp)"
  summary_body="$(mktemp)"
  status="$(curl -sS -H 'Cache-Control: no-cache' -o "${body}" -w '%{http_code}' "${version_url}" || true)"
  summary_status="$(curl -sS -H 'Cache-Control: no-cache' -o "${summary_body}" -w '%{http_code}' "${PACKAGE_API_URL}" || true)"

  if [[ "${status}" == "200" && "${summary_status}" == "200" ]]; then
    if python3 - "${body}" "${summary_body}" "${chart_version}" "${chart_license}" <<'PY'
import json
import sys

body_path, summary_body_path, expected_version, expected_license = sys.argv[1:5]
with open(body_path, encoding="utf-8") as handle:
    package = json.load(handle)
with open(summary_body_path, encoding="utf-8") as handle:
    summary = json.load(handle)

actual_version = package.get("version")
if actual_version != expected_version:
    raise SystemExit(f"Artifact Hub returned version {actual_version!r}; expected {expected_version!r}")

if expected_license:
    actual_license = package.get("license")
    if actual_license != expected_license:
        raise SystemExit(f"Artifact Hub returned license {actual_license!r}; expected {expected_license!r}")

content_url = package.get("content_url") or ""
if f":{expected_version}" not in content_url:
    raise SystemExit(f"Artifact Hub content_url {content_url!r} does not reference {expected_version!r}")

if package.get("has_values_schema") is not True:
    raise SystemExit("Artifact Hub package does not report values schema support")

if package.get("has_changelog") is not True:
    raise SystemExit("Artifact Hub package does not report changelog support")

summary_version = summary.get("version")
if summary_version != expected_version:
    versions = [entry.get("version") for entry in summary.get("available_versions", [])]
    raise SystemExit(
        "Artifact Hub package summary latest="
        f"{summary_version!r}; expected {expected_version!r}; "
        f"available_versions={','.join(v for v in versions if v)}"
    )

summary_content_url = summary.get("content_url") or ""
if f":{expected_version}" not in summary_content_url:
    raise SystemExit(
        f"Artifact Hub package summary content_url {summary_content_url!r} "
        f"does not reference {expected_version!r}"
    )

summary_versions = [entry.get("version") for entry in summary.get("available_versions", [])]
if expected_version not in summary_versions:
    raise SystemExit(
        "Artifact Hub package summary does not list "
        f"{expected_version!r}; available_versions={','.join(v for v in summary_versions if v)}"
    )

print(
    "Artifact Hub indexed "
    f"{package.get('name')} {actual_version} at {content_url}; "
    f"license={package.get('license')}; signed={package.get('signed')}; "
    f"summary_latest={summary_version}"
)
PY
    then
      rm -f "${body}" "${summary_body}"
      exit 0
    fi
  elif [[ "${summary_status}" != "200" ]]; then
    echo "Artifact Hub summary request returned HTTP ${summary_status}" >&2
  fi

  if [[ "${summary_status}" == "200" ]]; then
    python3 - "${summary_body}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    package = json.load(handle)

versions = [entry.get("version") for entry in package.get("available_versions", [])]
print(
    "Artifact Hub latest="
    f"{package.get('version')} available_versions={','.join(v for v in versions if v)}"
)
PY
  fi
  rm -f "${body}" "${summary_body}"

  if ((SECONDS >= deadline)); then
    echo "Timed out waiting for Artifact Hub to index ${chart_version} from ${PACKAGE_API_URL}" >&2
    exit 1
  fi

  sleep "${INTERVAL_SECONDS}"
done
