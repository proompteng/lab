#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fixture="$(cd "$(mktemp -d)" && pwd -P)"
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
      lock = builtins.fromJSON (builtins.readFile ${repo_root}/flake.lock);
      nixpkgs = builtins.fetchTree (builtins.getAttr lock.nodes.root.inputs.nixpkgs lock.nodes).locked;
      lib = import (nixpkgs.outPath + \"/lib\");
      expectedSource = import ${repo_root}/nix/images/bun-workspace-deps-source.nix {
        inherit lib;
        repoRoot = ${fixture};
      };
      runtime = import ${repo_root}/nix/images/bun-workspace-service.nix {
        inherit lib;
        repoRoot = ${fixture};
        pkgs.stdenvNoCC.mkDerivation = args: args // { outPath = args.src; };
        bun = null;
        nodejs = null;
        serviceName = \"fixture\";
        packageName = \"@fixture/demo\";
        depsHash = lib.fakeHash;
        installFilters = [ \"@fixture/demo\" ];
        sourcePaths = [ \"apps/demo\" ];
        command = [ ];
        returnRuntimeRoot = true;
      };
    in
    assert lib.hasInfix (\"cp -R \" + builtins.unsafeDiscardStringContext (toString expectedSource) + \"/.\") runtime.buildPhase;
    toString expectedSource
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

included_files="$(cd "${baseline}" && find . -type f | sed 's|^./||' | LC_ALL=C sort)"
expected_files='.npmrc
apps/demo/package.json
bun.lock
package.json
patches/example.patch'
if [[ "${included_files}" != "${expected_files}" ]]; then
  printf 'unexpected dependency source file set:\n' >&2
  printf '  %s\n' "${included_files}" >&2
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

cp "${fixture}/bun.lock" "${fixture}/bun.lock.original"
printf '\n' >> "${fixture}/bun.lock"
expect_different "lockfile change" "${baseline}" "$(dependency_source)"
mv "${fixture}/bun.lock.original" "${fixture}/bun.lock"

mkdir -p "${fixture}/apps/second"
printf '{"name":"@fixture/second","private":true}\n' > "${fixture}/apps/second/package.json"
expect_different "workspace manifest addition" "${baseline}" "$(dependency_source)"

printf 'baseline dependency source: %s\n' "${baseline}"
printf 'included dependency files:\n'
printf '  %s\n' "${included_files}"
printf 'source-only additions and directory-shape changes preserved the dependency source identity\n'
printf 'manifest and lockfile changes changed the dependency source identity\n'

metadata_fixture="${fixture}/metadata"
mkdir -p "${metadata_fixture}/source/packages/sdk" "${metadata_fixture}/before" "${metadata_fixture}/after"
cat > "${metadata_fixture}/source/package.json" <<'EOF'
{"name":"metadata-fixture","private":true,"workspaces":["packages/*"],"dependencies":{"@fixture/sdk":"workspace:*"}}
EOF
cat > "${metadata_fixture}/source/packages/sdk/package.json" <<'EOF'
{"name":"@fixture/sdk","version":"0.11.3","type":"module","exports":"./index.js"}
EOF
(
  cd "${metadata_fixture}/source"
  bun install --lockfile-only --ignore-scripts
)

build_metadata_fixture() {
  local destination="$1"
  cp -R "${metadata_fixture}/source/." "${destination}/"
  (
    cd "${destination}"
    bun install --frozen-lockfile --ignore-scripts --backend=copyfile --linker=isolated
  )
  mkdir -p "${destination}/node_modules/external-fixture/empty"
  printf '{"name":"external-fixture","version":"1.0.0"}\n' > "${destination}/node_modules/external-fixture/package.json"
  bash "${repo_root}/nix/images/prune-bun-dependency-metadata.sh" "${destination}"
  test ! -f "${destination}/package.json"
  test ! -f "${destination}/packages/sdk/package.json"
  test -f "${destination}/node_modules/external-fixture/package.json"
  test -d "${destination}/node_modules/external-fixture/empty"
}

build_metadata_fixture "${metadata_fixture}/before"
cat > "${metadata_fixture}/source/packages/sdk/package.json" <<'EOF'
{"name":"@fixture/sdk","version":"0.11.4","type":"module","exports":"./index.js","scripts":{"release":"bun release.ts"}}
EOF
build_metadata_fixture "${metadata_fixture}/after"
expect_same "SDK version and release script change" \
  "$(nix hash path "${metadata_fixture}/before")" \
  "$(nix hash path "${metadata_fixture}/after")"

cp -R "${metadata_fixture}/source/." "${metadata_fixture}/after/"
printf 'export const version = "0.11.4"\n' > "${metadata_fixture}/after/packages/sdk/index.js"
(
  cd "${metadata_fixture}/after"
  bun -e 'import { version } from "@fixture/sdk"; if (version !== "0.11.4") throw new Error("Stale workspace source")'
  bun -e 'const pkg = await Bun.file("packages/sdk/package.json").json(); if (pkg.version !== "0.11.4" || !pkg.scripts.release) throw new Error("Stale workspace manifest")'
)
printf 'release metadata preserved the dependency closure hash and current workspace resolution\n'
