#!/usr/bin/env bash
set -euo pipefail

cache_url="${ATTIC_CACHE_URL:-${NIX_CACHE_URL:-https://attic.ide-newton.ts.net/lab}}"
public_key="${ATTIC_PUBLIC_KEY:-}"

if [[ "${cache_url}" != http://* && "${cache_url}" != https://* ]]; then
  echo "ATTIC_CACHE_URL must be an http(s) URL, got: ${cache_url}" >&2
  exit 2
fi

echo "Checking Nix cache endpoint: ${cache_url}"
cache_info="$(curl -fsSL "${cache_url%/}/nix-cache-info")"
printf '%s\n' "${cache_info}"

if ! grep -Fq 'StoreDir: /nix/store' <<<"${cache_info}"; then
  echo "Cache endpoint did not return a Nix cache-info document." >&2
  exit 1
fi

if [[ -n "${public_key}" ]]; then
  nix_config="$(nix show-config 2>/dev/null || true)"
  nix_config="${nix_config}"$'\n'"${NIX_CONFIG:-}"

  if ! grep -Fq "${cache_url}" <<<"${nix_config}"; then
    echo "Nix config does not include substituter ${cache_url}." >&2
    exit 1
  fi

  if ! grep -Fq "${public_key}" <<<"${nix_config}"; then
    echo "Nix config does not include ATTIC_PUBLIC_KEY." >&2
    exit 1
  fi
else
  echo "ATTIC_PUBLIC_KEY is unset; skipping local trusted-public-key verification."
fi

echo "Attic cache doctor passed."
