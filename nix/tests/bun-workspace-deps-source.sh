#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "${fixture}"' EXIT

mkdir -p \
  "${fixture}/apps/demo/src/existing" \
  "${fixture}/patches"

cat > "${fixture}/package.json" <<'EOF'
{
  "name": "fixture",
  "private": true,
  "workspaces": ["apps/*"]
}
EOF

cat > "${fixture}/apps/demo/package.json" <<'EOF'
{
  "name": "@fixture/demo",
  "private": true,
  "dependencies": {
    "effect": "1.0.0"
  }
}
EOF

cat > "${fixture}/bun.lock" <<'EOF'
{"lockfileVersion":1,"workspaces":{"":{"name":"fixture"},"apps/demo":{"name":"@fixture/demo"}}}
EOF

printf 'registry=https://registry.npmjs.org/\n' > "${fixture}/.npmrc"
printf 'fixture patch\n' > "${fixture}/patches/example.patch"
printf 'export const existing = true\n' > "${fixture}/apps/demo/src/existing/index.ts"

dependency_source() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake (toString ${repo_root});
    in
    import ${repo_root}/nix/images/bun-workspace-deps-source.nix {
      lib = flake.inputs.nixpkgs.lib;
      repoRoot = ${fixture};
    }
  "
}

expect_same() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    printf '%s changed dependency source unexpectedly:\n  expected %s\n  actual   %s\n' \
      "${description}" "${expected}" "${actual}" >&2
    exit 1
  fi
}

expect_different() {
  local description="$1"
  local baseline="$2"
  local actual="$3"
  if [[ "${actual}" == "${baseline}" ]]; then
    printf '%s did not change dependency source: %s\n' "${description}" "${actual}" >&2
    exit 1
  fi
}

baseline="$(dependency_source)"

mapfile -t included_files < <(cd "${baseline}" && find . -type f -printf '%P\n' | sort)
expected_files=(
  .npmrc
  apps/demo/package.json
  bun.lock
  package.json
  patches/example.patch
)
if [[ "${included_files[*]}" != "${expected_files[*]}" ]]; then
  printf 'unexpected dependency source file set:\n' >&2
  printf '  %s\n' "${included_files[@]}" >&2
  exit 1
fi

mkdir -p "${fixture}/apps/demo/src/new/deep/tree"
printf 'export const added = true\n' > "${fixture}/apps/demo/src/new/deep/tree/added.ts"
expect_same "source-only file addition" "${baseline}" "$(dependency_source)"

mv "${fixture}/apps/demo/src/new" "${fixture}/apps/demo/rearranged-source"
mkdir -p "${fixture}/apps/demo/src/empty/directory/shape"
expect_same "source-only directory-shape change" "${baseline}" "$(dependency_source)"

perl -0pi -e 's/"effect": "1\.0\.0"/"effect": "2.0.0"/' "${fixture}/apps/demo/package.json"
expect_different "workspace manifest change" "${baseline}" "$(dependency_source)"
perl -0pi -e 's/"effect": "2\.0\.0"/"effect": "1.0.0"/' "${fixture}/apps/demo/package.json"

printf '\n' >> "${fixture}/bun.lock"
expect_different "lockfile change" "${baseline}" "$(dependency_source)"
truncate -s -1 "${fixture}/bun.lock"

mkdir -p "${fixture}/apps/second"
printf '{"name":"@fixture/second","private":true}\n' > "${fixture}/apps/second/package.json"
expect_different "workspace manifest addition" "${baseline}" "$(dependency_source)"

printf 'baseline dependency source: %s\n' "${baseline}"
printf 'included dependency files:\n'
printf '  %s\n' "${included_files[@]}"
printf 'source-only additions and directory-shape changes preserved the dependency source identity\n'
printf 'manifest and lockfile changes changed the dependency source identity\n'
