#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: postgres-upgrade-image-plan.sh [--phase allowed|config|preparation|major]
                                      [--emit]

Checks the desired image in every owned Cluster manifest against the approved
PostgreSQL image plan and verifies the phase-B Backup references. This helper
is read-only; it does not run kubectl, edit files, or apply a deployment. Run
it again after each GitOps image wave.

Phases:
  allowed      accept current, preparation, or major image for every cluster
  config       require current images for the eight config-wave clusters and
               allow current/preparation images for the four already-protected
               clusters
  preparation  require the approved same-major preparation image everywhere and
               require Backup references for the eight config-wave clusters
  major        require the approved PostgreSQL 18.6 image everywhere and the
               phase-B Backup references
EOF
  exit 2
}

die() {
  echo "postgres-upgrade-image-plan: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
plan_file="${repo_root}/scripts/cluster-upgrades/postgres-upgrade-image-plan.yaml"
phase=allowed
emit=false

while (($# > 0)); do
  case "$1" in
    --phase)
      (($# >= 2)) || usage
      phase="$2"
      shift 2
      ;;
    --emit)
      emit=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

case "$phase" in
  allowed|config|preparation|major) ;;
  *) usage ;;
esac

[[ -r "$plan_file" ]] || die "plan file is missing: $plan_file"
yq_bin="${YQ_BIN:-yq}"
command -v "$yq_bin" >/dev/null 2>&1 || die "yq is required (set YQ_BIN to its path)"

row_count=0
while IFS= read -r row; do
  row_count=$((row_count + 1))
  IFS=$'\t' read -r manifest backup_manifest namespace cluster config_wave current_image preparation_image major_image <<<"$row"
  [[ "$backup_manifest" == "-" ]] && backup_manifest=""
  path="${repo_root}/${manifest}"
  [[ -r "$path" ]] || die "manifest is missing: ${manifest}"

  if [[ "$config_wave" == true ]]; then
    [[ -n "$backup_manifest" ]] || die "${namespace}/${cluster} has no phase-B backupManifest"
    backup_path="${repo_root}/${backup_manifest}"
    [[ -r "$backup_path" ]] || die "backup manifest is missing: ${backup_manifest}"
    grep -Eq '^kind:[[:space:]]+Backup[[:space:]]*$' "$backup_path" || \
      die "${backup_manifest} is not a CNPG Backup manifest"
    grep -Eq '^  method:[[:space:]]+volumeSnapshot[[:space:]]*$' "$backup_path" || \
      die "${backup_manifest} must use method: volumeSnapshot"

    if [[ "$phase" == preparation || "$phase" == major ]]; then
      kustomization_path="${path%/*}/kustomization.yaml"
      backup_resource="${backup_manifest##*/}"
      [[ -r "$kustomization_path" ]] || die "Kustomization is missing for ${namespace}/${cluster}"
      grep -Fq "$backup_resource" "$kustomization_path" || \
        die "${namespace}/${cluster} phase ${phase} must reference ${backup_resource}"
    fi
  fi

  image_lines="$(sed -n 's/^  imageName: //p' "$path")"
  image_count="$(printf '%s\n' "$image_lines" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
  [[ "$image_count" == 1 ]] || die "expected one imageName in ${manifest}, found ${image_count}"
  actual_image="$(printf '%s\n' "$image_lines" | sed -n '1p')"

  case "$phase" in
    allowed)
      expected_images=("$current_image" "$preparation_image" "$major_image")
      ;;
    config)
      if [[ "$config_wave" == true ]]; then
        expected_images=("$current_image")
      else
        expected_images=("$current_image" "$preparation_image")
      fi
      ;;
    preparation)
      expected_images=("$preparation_image")
      ;;
    major)
      expected_images=("$major_image")
      ;;
  esac

  matched=false
  for expected_image in "${expected_images[@]}"; do
    if [[ "$actual_image" == "$expected_image" ]]; then
      matched=true
      break
    fi
  done
  [[ "$matched" == true ]] || die "${namespace}/${cluster} has ${actual_image}; expected one of ${expected_images[*]} for phase ${phase}"

  if [[ "$emit" == true ]]; then
    printf '%s\t%s\t%s\t%s\n' "$manifest" "$backup_manifest" "$cluster" "$major_image"
  fi
done < <("$yq_bin" -r '.clusters[] | [.manifest, (.backupManifest // "-"), .namespace, .name, (.configWave | tostring), .currentImage, .preparationImage, .majorImage] | @tsv' "$plan_file")
[[ "$row_count" -eq 12 ]] || die "expected 12 cluster plan rows, found ${row_count}"

echo "PostgreSQL image plan passed: phase=${phase} clusters=${row_count}" >&2
