#!/usr/bin/env bash

set -eo pipefail

usage() {
  cat >&2 <<'EOF'
usage: postgres-upgrade-preflight.sh --namespace NAMESPACE --cluster CLUSTER \
  --target-image IMAGE [--phase prepare|major] [--target-server-name NAME] \
  [--context KUBE_CONTEXT]

The command is read-only. It validates the live Cluster, image lineage, backup
evidence, and installed extensions before an Argo-driven image transition.
EOF
  exit 2
}

die() {
  echo "postgres-upgrade-preflight: $*" >&2
  exit 1
}

KUBECTL_BIN="$(printenv KUBECTL_BIN 2>/dev/null || printf kubectl)"
JQ_BIN="$(printenv JQ_BIN 2>/dev/null || printf jq)"
KUBE_CONTEXT="$(printenv KUBE_CONTEXT 2>/dev/null || printf galactic-lan)"
MAX_BACKUP_AGE_SECONDS="$(printenv MAX_BACKUP_AGE_SECONDS 2>/dev/null || printf 172800)"
phase=major
namespace=
cluster=
target_image=
target_server_name=

while (($# > 0)); do
  case "$1" in
    --namespace)
      (($# >= 2)) || usage
      namespace="$2"
      shift 2
      ;;
    --cluster)
      (($# >= 2)) || usage
      cluster="$2"
      shift 2
      ;;
    --target-image)
      (($# >= 2)) || usage
      target_image="$2"
      shift 2
      ;;
    --phase)
      (($# >= 2)) || usage
      phase="$2"
      shift 2
      ;;
    --target-server-name)
      (($# >= 2)) || usage
      target_server_name="$2"
      shift 2
      ;;
    --context)
      (($# >= 2)) || usage
      KUBE_CONTEXT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$namespace" =~ ^[A-Za-z0-9.-]+$ ]] || usage
[[ "$cluster" =~ ^[A-Za-z0-9.-]+$ ]] || usage
[[ "$phase" == "prepare" || "$phase" == "major" ]] || usage
[[ -n "$target_image" ]] || usage
[[ -n "$KUBE_CONTEXT" ]] || usage
command -v "$KUBECTL_BIN" >/dev/null 2>&1 || die "kubectl is required"
command -v "$JQ_BIN" >/dev/null 2>&1 || die "jq is required"
[[ "$MAX_BACKUP_AGE_SECONDS" =~ ^[0-9]+$ ]] || die "MAX_BACKUP_AGE_SECONDS must be an integer"

target_major=
target_minor=
target_distro=
case "$target_image" in
  ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e)
    target_major=17; target_minor=11; target_distro=bullseye
    ;;
  ghcr.io/cloudnative-pg/postgresql:17.11-system-trixie@sha256:362b039f643f1c09a34edd63d9a78903e5f1f4f43c24236cc8459621eb676d12)
    target_major=17; target_minor=11; target_distro=trixie
    ;;
  ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533)
    target_major=18; target_minor=6; target_distro=bullseye
    ;;
  ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1)
    target_major=18; target_minor=6; target_distro=trixie
    ;;
  *)
    die "target image is not a verified immutable PostgreSQL 17.11/18.6 reference: $target_image"
    ;;
esac

cluster_json="$($KUBECTL_BIN --context "$KUBE_CONTEXT" --namespace "$namespace" get cluster "$cluster" -o json 2>/dev/null)" || \
  die "unable to read Cluster $namespace/$cluster"
api_version="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.apiVersion // empty')"
kind="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.kind // empty')"
[[ "$api_version" == "postgresql.cnpg.io/v1" && "$kind" == "Cluster" ]] || \
  die "$namespace/$cluster is not a postgresql.cnpg.io/v1 Cluster"

ready="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '[.status.conditions[]? | select(.type == "Ready") | .status][0] // "False"')"
[[ "$ready" == "True" ]] || die "Cluster is not Ready (condition=$ready)"
status_phase="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.status.phase // empty')"
status_phase_display="$status_phase"
[[ -n "$status_phase_display" ]] || status_phase_display='<empty>'
[[ "$status_phase" == "Cluster in healthy state" ]] || die "Cluster phase is not healthy: $status_phase_display"

instances="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.spec.instances // 0')"
ready_instances="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.status.readyInstances // 0')"
[[ "$instances" =~ ^[0-9]+$ && "$instances" -gt 0 ]] || die "Cluster has no valid spec.instances"
[[ "$ready_instances" == "$instances" ]] || die "only $ready_instances/$instances instances are ready"

source_image="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.status.pgDataImageInfo.image // .spec.imageName // empty')"
[[ -n "$source_image" ]] || die "Cluster does not report status.pgDataImageInfo.image"
source_major="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.status.pgDataImageInfo.majorVersion // empty')"
source_tag="$(printf '%s' "$source_image" | cut -d@ -f1 | awk -F: '{print $NF}')"
source_minor="$(printf '%s' "$source_tag" | awk -F. '{print $2}' | sed 's/[^0-9].*//')"
[[ "$source_major" =~ ^[0-9]+$ && "$source_minor" =~ ^[0-9]+$ ]] || die "cannot parse PostgreSQL version from $source_image"

source_distro=
case "$source_tag" in
  *-trixie) source_distro=trixie ;;
  17.0|17.11) source_distro=bullseye ;;
  *) die "cannot establish the Debian family for source image $source_image; refuse an unsafe upgrade" ;;
esac

echo "Cluster $namespace/$cluster: PostgreSQL $source_major.$source_minor ($source_distro) -> $target_major.$target_minor ($target_distro)"
[[ "$source_distro" == "$target_distro" ]] || \
  die "CloudNativePG pg_upgrade requires the same OS family (source=$source_distro target=$target_distro)"

if [[ "$phase" == "prepare" ]]; then
  [[ "$source_major" == "$target_major" ]] || die "prepare phase must keep the PostgreSQL major unchanged"
  echo "Preparation image is same-major and OS-compatible."
else
  [[ "$source_major" == "17" && "$target_major" == "18" ]] || die "major phase only permits PostgreSQL 17 -> 18"
  if ((source_minor < 6)); then
    die "source PostgreSQL $source_major.$source_minor is too old for pg_upgrade; converge to verified 17.11 first"
  fi

  max_slot_wal_keep_size="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.spec.postgresql.parameters.max_slot_wal_keep_size // "-1"')"
  if ((source_minor < 6)) && [[ "$max_slot_wal_keep_size" != "-1" ]]; then
    die "PostgreSQL 17.0-17.5 requires max_slot_wal_keep_size=-1 before pg_upgrade (found $max_slot_wal_keep_size)"
  fi

  barman_server="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '(.spec.backup.barmanObjectStore.serverName // ([.spec.plugins[]? | select((.name // "") | contains("barman")) | .parameters.serverName][0])) // empty')"
  if [[ -n "$barman_server" ]]; then
    [[ "$target_server_name" =~ ^[A-Za-z0-9._-]{1,63}$ ]] || die "Barman-backed major upgrade requires --target-server-name"
    [[ "$target_server_name" != "$barman_server" ]] || die "Barman serverName must change for a major upgrade (old=$barman_server)"
    echo "Barman archive separation: $barman_server -> $target_server_name"
  fi

  backups_json="$($KUBECTL_BIN --context "$KUBE_CONTEXT" --namespace "$namespace" get backups.postgresql.cnpg.io -o json 2>/dev/null)" || \
    die "unable to read CNPG Backup resources; refuse a major upgrade without backup evidence"
  # shellcheck disable=SC2016
  latest_backup="$(printf '%s' "$backups_json" | "$JQ_BIN" -r --arg cluster "$cluster" '
    [.items[]? | select(.spec.cluster.name == $cluster and .status.phase == "completed" and (.status.stoppedAt // "") != "")]
    | sort_by(.status.stoppedAt) | last // empty
    | [.metadata.name, .status.stoppedAt, .spec.method] | @tsv')"
  [[ -n "$latest_backup" ]] || die "no completed CNPG Backup exists for $namespace/$cluster"
  IFS=$'\t' read -r backup_name backup_stopped_at backup_method <<EOF
$latest_backup
EOF
  backup_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$backup_stopped_at" +%s 2>/dev/null || true)"
  if [[ -z "$backup_epoch" ]]; then
    backup_epoch="$(date -u -d "$backup_stopped_at" +%s 2>/dev/null || true)"
  fi
  [[ "$backup_epoch" =~ ^[0-9]+$ ]] || die "cannot parse completed backup timestamp $backup_stopped_at"
  now_epoch="$(printenv NOW_EPOCH 2>/dev/null || true)"
  [[ -n "$now_epoch" ]] || now_epoch="$(date -u +%s)"
  [[ "$now_epoch" =~ ^[0-9]+$ ]] || die "NOW_EPOCH must be an integer"
  backup_age=$((now_epoch - backup_epoch))
  ((backup_age < 0)) && backup_age=0
  ((backup_age <= MAX_BACKUP_AGE_SECONDS)) || die "latest completed backup $backup_name is $backup_age s old (limit=$MAX_BACKUP_AGE_SECONDS s)"
  echo "Backup evidence: $backup_name method=$backup_method stoppedAt=$backup_stopped_at age=$backup_age s"
fi

run_psql() {
  local database="$1"
  local sql="$2"
  "$KUBECTL_BIN" --context "$KUBE_CONTEXT" cnpg psql "$cluster" --namespace "$namespace" -- -d "$database" -At -c "$sql" < /dev/null 2>/dev/null
}

if ! databases="$(run_psql postgres 'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;')"; then
  die "unable to discover databases for extension compatibility check"
fi
if [[ -z "$databases" ]]; then
  bootstrap_database="$(printf '%s' "$cluster_json" | "$JQ_BIN" -r '.spec.bootstrap.initdb.database // empty')"
  [[ -n "$bootstrap_database" ]] || die "cannot discover databases for extension compatibility check"
  databases="$bootstrap_database"
fi

extension_names=
for database in $databases; do
  [[ "$database" =~ ^[A-Za-z0-9_.$-]+$ ]] || die "refusing to inspect unsafe database name $database"
  if ! extensions="$(run_psql "$database" 'SELECT extname FROM pg_extension ORDER BY 1;')"; then
    die "unable to inspect extensions in database $database"
  fi
  extensions="$(printf '%s' "$extensions" | tr '\n' ' ')"
  [[ -n "$extensions" ]] || continue
  if [[ -n "$extension_names" ]]; then extension_names="$extension_names $extensions"; else extension_names="$extensions"; fi
done

for extension in $extension_names; do
  case "$extension" in
    plpgsql|pgcrypto|pg_trgm|vector) ;;
    *) die "extension $extension is not verified in the target CloudNativePG 17.11/18.6 system images" ;;
  esac
done
extension_display="$extension_names"
[[ -n "$extension_display" ]] || extension_display=none
echo "Extension compatibility: $extension_display (target system images verified)"
echo "Preflight passed (read-only). Apply the desired image through Argo, then run postgres-upgrade-postflight.sh."
