#!/usr/bin/env bash
set -euo pipefail
source_nix="${1:?}"
persistent_nix="${2:?}"
registration="${3:?}"
toolchain="${4:?}"
install -d -m 0755 "$persistent_nix"
receipt="$persistent_nix/var/nix/devbox-registration.sha256"
digest="$(sha256sum "$registration")"
digest="${digest%% *}"
seed_required=true
if [[ -f "$receipt" && "$(cat "$receipt")" == "$digest" &&
      -s "$persistent_nix/var/nix/db/db.sqlite" &&
      -d "$persistent_nix/store/${toolchain##*/}" ]]; then
  seed_required=false
fi

if "$seed_required"; then
  rsync -a --ignore-existing "$source_nix/" "$persistent_nix/"
fi
mount --bind "$persistent_nix" "$source_nix"
if "$seed_required"; then
  NIX_REMOTE=local "$toolchain/bin/nix-store" --register-validity --hash-given < "$registration"
  install -d "$source_nix/var/nix/gcroots"
  ln -sfn "$toolchain" "$source_nix/var/nix/gcroots/devbox-toolchain"
  printf '%s\n' "$digest" > "$receipt.tmp"
  mv "$receipt.tmp" "$receipt"
fi
