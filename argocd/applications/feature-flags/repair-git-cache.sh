#!/bin/sh
set -eu

repository_path=$1
remote_refs_path="$repository_path/refs/remotes/origin"

if [ ! -d "$remote_refs_path" ]; then
  exit 0
fi

find "$remote_refs_path" -type f ! -name '*.lock' -size 0 -exec sh -eu -c '
  repository_path=$1
  shift
  for reference_path do
    if [ ! -f "$reference_path" ] || [ -s "$reference_path" ]; then
      continue
    fi
    mkdir -p "$repository_path.ref-backups"
    backup_path=$(mktemp -d "$repository_path.ref-backups/empty-ref.XXXXXX")
    relative_path=${reference_path#"$repository_path"/}
    mkdir -p "$backup_path/$(dirname "$relative_path")"
    mv "$reference_path" "$backup_path/$relative_path"
    printf "Backed up empty Git reference %s to %s\n" "$relative_path" "$backup_path/$relative_path"
  done
' sh "$repository_path" {} +
