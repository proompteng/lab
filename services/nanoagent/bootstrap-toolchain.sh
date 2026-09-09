#!/usr/bin/env bash
set -euo pipefail

readonly NODE_VERSION='24.11.1'
readonly BUN_VERSION='1.4.0'
readonly UV_VERSION='0.11.14'
readonly GO_VERSION='1.25.5'
readonly RUST_VERSION='1.90.0'
readonly C_COMPILER_MAJOR='13'
readonly C_COMPILER_VERSION='13.3.0'
readonly TOOLCHAIN_BUNDLE='/usr/share/nanoagent/development-toolchain.tar.xz'

platform=''
linux_triplet=''
rust_target=''
dynamic_linker=''
temporary_directory=''

cleanup() {
  if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}

fail() {
  printf 'bootstrap-toolchain: %s\n' "$*" >&2
  exit 1
}

select_platform() {
  case "$(uname -m)" in
    x86_64)
      platform='linux-x64'
      linux_triplet='x86_64-linux-gnu'
      rust_target='x86_64-unknown-linux-gnu'
      dynamic_linker='/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'
      ;;
    aarch64 | arm64)
      platform='linux-arm64'
      linux_triplet='aarch64-linux-gnu'
      rust_target='aarch64-unknown-linux-gnu'
      dynamic_linker='/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1'
      ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

validate_manifest() {
  select_platform
  [[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid Node version'
  [[ "$BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid Bun version'
  [[ "$UV_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid uv version'
  [[ "$GO_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid Go version'
  [[ "$RUST_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid Rust version'
  [[ "$C_COMPILER_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid C compiler version'
  [[ -r "$TOOLCHAIN_BUNDLE" ]] || fail "toolchain bundle is unavailable: $TOOLCHAIN_BUNDLE"
}

validate_install() {
  local install_root="$1"
  local expected_marker="$2"
  local marker="$install_root/.tengri-toolchain-manifest"

  [[ -x "$install_root/node/bin/node" ]] || fail "Node install is incomplete: $install_root"
  [[ -x "$install_root/node/lib/node_modules/npm/bin/npm-cli.js" ]] || fail "npm install is incomplete: $install_root"
  [[ -x "$install_root/node/lib/node_modules/npm/bin/npx-cli.js" ]] || fail "npx install is incomplete: $install_root"
  [[ -x "$install_root/bun/bin/bun" ]] || fail "Bun install is incomplete: $install_root"
  [[ -x "$install_root/uv/bin/uv" ]] || fail "uv install is incomplete: $install_root"
  [[ -x "$install_root/uv/bin/uvx" ]] || fail "uvx install is incomplete: $install_root"
  [[ -x "$install_root/go/bin/go" ]] || fail "Go install is incomplete: $install_root"
  [[ -x "$install_root/go/bin/gofmt" ]] || fail "gofmt install is incomplete: $install_root"
  [[ -x "$install_root/c/bin/${linux_triplet}-gcc-${C_COMPILER_MAJOR}" ]] || fail "C compiler install is incomplete: $install_root"
  [[ -x "$install_root/c/bin/${linux_triplet}-as" ]] || fail "C assembler install is incomplete: $install_root"
  [[ -x "$install_root/c/bin/${linux_triplet}-ld.bfd" ]] || fail "C linker install is incomplete: $install_root"
  [[ -x "$install_root/c/bin/as" ]] || fail "C assembler shim is incomplete: $install_root"
  [[ -x "$install_root/c/bin/ld" ]] || fail "C linker shim is incomplete: $install_root"
  [[ -x "$install_root/c/libexec/gcc/$linux_triplet/$C_COMPILER_MAJOR/cc1" ]] || fail "C compiler frontend is incomplete: $install_root"
  [[ -f "$install_root/c/sysroot/usr/include/stdlib.h" ]] || fail "C compiler headers are incomplete: $install_root"
  [[ -f "$install_root/c/sysroot/usr/lib/$linux_triplet/Scrt1.o" ]] || fail "C compiler sysroot is incomplete: $install_root"
  [[ "$(<"$install_root/c/compiler-version")" == "$C_COMPILER_VERSION" ]] || fail 'C compiler version mismatch'
  [[ -x "$install_root/rust/bin/rustc" ]] || fail "rustc install is incomplete: $install_root"
  [[ -x "$install_root/rust/bin/cargo" ]] || fail "Cargo install is incomplete: $install_root"
  [[ -x "$install_root/rust/bin/rustdoc" ]] || fail "rustdoc install is incomplete: $install_root"
  [[ -x "$install_root/rust/lib/rustlib/$rust_target/bin/rust-lld" ]] || fail "Rust linker is incomplete: $install_root"
  for startup_object in Scrt1.o crti.o crtn.o crtbeginS.o crtendS.o; do
    [[ -f "$install_root/linker/crt/$startup_object" ]] || fail "Rust startup object is missing: $startup_object"
  done
  [[ -f "$marker" ]] || fail "toolchain install has no manifest: $install_root"
  [[ "$(<"$marker")" == "$expected_marker" ]] || fail "toolchain install has an invalid manifest: $install_root"
  [[ "$("$install_root/node/bin/node" --version)" == "v$NODE_VERSION" ]] || fail 'Node version mismatch'
  [[ "$("$install_root/bun/bin/bun" --version)" == "$BUN_VERSION" ]] || fail 'Bun version mismatch'
  [[ "$("$install_root/uv/bin/uv" --version | cut -d' ' -f2)" == "$UV_VERSION" ]] || fail 'uv version mismatch'
  [[ "$(GOROOT="$install_root/go" "$install_root/go/bin/go" version | cut -d' ' -f3)" == "go$GO_VERSION" ]] || fail 'Go version mismatch'
  [[ "$("$install_root/rust/bin/rustc" --version | cut -d' ' -f2)" == "$RUST_VERSION" ]] || fail 'Rust version mismatch'
  [[ "$("$install_root/rust/bin/cargo" --version | cut -d' ' -f2)" == "$RUST_VERSION" ]] || fail 'Cargo version mismatch'
  [[ "$("$install_root/rust/bin/rustdoc" --version | cut -d' ' -f2)" == "$RUST_VERSION" ]] || fail 'rustdoc version mismatch'
}

write_c_compiler_wrapper() {
  local destination="$1"
  local compiler_root="$2"
  local temporary_wrapper="${destination}.tmp.$$"

  rm -f -- "$temporary_wrapper"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    # The parameter expansion is intentionally emitted into the generated wrapper.
    # shellcheck disable=SC2016
    printf 'export LD_LIBRARY_PATH=%q"${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\n' "$compiler_root/runtime"
    printf 'exec %q --sysroot=%q -B%q -B%q -B%q "$@"\n' \
      "$compiler_root/bin/${linux_triplet}-gcc-${C_COMPILER_MAJOR}" \
      "$compiler_root/sysroot" \
      "$compiler_root/libexec/gcc/$linux_triplet/$C_COMPILER_MAJOR/" \
      "$compiler_root/bin/" \
      "$compiler_root/lib/gcc/$linux_triplet/$C_COMPILER_MAJOR/"
  } > "$temporary_wrapper"
  chmod 0700 "$temporary_wrapper"
  mv -Tf "$temporary_wrapper" "$destination"
}

prepare_c_compiler() {
  local install_root="$1"
  local compiler_root="$install_root/c"
  local compiler_wrapper="$HOME/.local/bin/gcc"

  write_c_compiler_wrapper "$compiler_wrapper" "$compiler_root"
  link_binary "$compiler_wrapper" "$HOME/.local/bin/cc"
}

link_binary() {
  local source="$1"
  local destination="$2"
  local temporary_link="${destination}.tmp.$$"

  rm -f -- "$temporary_link"
  ln -s "$source" "$temporary_link"
  mv -Tf "$temporary_link" "$destination"
}

write_rust_wrapper() {
  local destination="$1"
  shift
  local temporary_wrapper="${destination}.tmp.$$"

  rm -f -- "$temporary_wrapper"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'exec'
    printf ' %q' "$@"
    printf ' "$@"\n'
  } > "$temporary_wrapper"
  chmod 0700 "$temporary_wrapper"
  mv -Tf "$temporary_wrapper" "$destination"
}

write_rust_linker_wrapper() {
  local destination="$1"
  local rust_lld="$2"
  local linker_root="$3"
  local linker_library_root="$4"
  local temporary_wrapper="${destination}.tmp.$$"

  rm -f -- "$temporary_wrapper"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'for argument in "$@"; do\n'
    # The argument expression is intentionally emitted into the generated wrapper.
    # shellcheck disable=SC2016
    printf '%s\n' '  if [[ "$argument" == "-shared" ]]; then'
    printf '    exec %q -flavor gnu -L%q "$@"\n' "$rust_lld" "$linker_library_root"
    printf '  fi\n'
    printf 'done\n'
    printf 'exec %q -flavor gnu %q %q %q -dynamic-linker %q -L%q "$@" %q %q\n' \
      "$rust_lld" \
      "$linker_root/crt/Scrt1.o" \
      "$linker_root/crt/crti.o" \
      "$linker_root/crt/crtbeginS.o" \
      "$dynamic_linker" \
      "$linker_library_root" \
      "$linker_root/crt/crtendS.o" \
      "$linker_root/crt/crtn.o"
  } > "$temporary_wrapper"
  chmod 0700 "$temporary_wrapper"
  mv -Tf "$temporary_wrapper" "$destination"
}

prepare_rust_linker() {
  local install_root="$1"
  local linker_root="$install_root/linker"
  local linker_library_root="$linker_root/lib"
  local rust_lld="$install_root/rust/lib/rustlib/$rust_target/bin/rust-lld"
  local rust_linker="$HOME/.local/bin/rust-linker"

  mkdir -p "$linker_library_root"
  for library_mapping in \
    'gcc_s:libgcc_s.so.1' \
    'util:libutil.so.1' \
    'rt:librt.so.1' \
    'pthread:libpthread.so.0' \
    'm:libm.so.6' \
    'dl:libdl.so.2' \
    'c:libc.so.6'; do
    local link_name="${library_mapping%%:*}"
    local runtime_name="${library_mapping#*:}"
    local runtime_library="/lib/$linux_triplet/$runtime_name"
    [[ -r "$runtime_library" ]] || fail "Rust runtime library is unavailable: $runtime_library"
    link_binary "$runtime_library" "$linker_library_root/lib$link_name.so"
  done
  [[ -x "$dynamic_linker" ]] || fail "dynamic linker is unavailable: $dynamic_linker"

  write_rust_linker_wrapper \
    "$rust_linker" \
    "$rust_lld" \
    "$linker_root" \
    "$linker_library_root"

  local rustc_wrapper="$HOME/.local/bin/rustc"
  write_rust_wrapper \
    "$rustc_wrapper" \
    "$install_root/rust/bin/rustc" \
    -C "linker=$rust_linker" \
    -C linker-flavor=ld

  local rustdoc_wrapper="$HOME/.local/bin/rustdoc"
  write_rust_wrapper \
    "$rustdoc_wrapper" \
    "$install_root/rust/bin/rustdoc" \
    -C "linker=$rust_linker" \
    -C linker-flavor=ld
}

install_toolchain() {
  validate_manifest
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute path'

  umask 077
  local toolchain_root="$HOME/.tengri/toolchains"
  local install_name="node-${NODE_VERSION}-bun-${BUN_VERSION}-uv-${UV_VERSION}-go-${GO_VERSION}-rust-${RUST_VERSION}-gcc-${C_COMPILER_VERSION}-${platform}"
  local install_root="$toolchain_root/$install_name"
  local expected_marker="node=${NODE_VERSION} bun=${BUN_VERSION} uv=${UV_VERSION} go=${GO_VERSION} rust=${RUST_VERSION} gcc=${C_COMPILER_VERSION} platform=${platform}"

  mkdir -p "$toolchain_root" "$HOME/.local/bin"
  chmod 0700 "$HOME/.tengri" "$toolchain_root" "$HOME/.local" "$HOME/.local/bin"

  if [[ -d "$install_root" ]]; then
    validate_install "$install_root" "$expected_marker"
  else
    temporary_directory="$(mktemp -d "$toolchain_root/.install.XXXXXX")"
    trap cleanup EXIT HUP INT TERM
    tar \
      --extract \
      --xz \
      --file "$TOOLCHAIN_BUNDLE" \
      --directory "$temporary_directory" \
      --no-same-owner \
      --no-same-permissions
    printf '%s\n' "$expected_marker" > "$temporary_directory/.tengri-toolchain-manifest"
    validate_install "$temporary_directory" "$expected_marker"
    mv "$temporary_directory" "$install_root"
    temporary_directory=''
    trap - EXIT HUP INT TERM
  fi

  link_binary "$install_root/node/bin/node" "$HOME/.local/bin/node"
  link_binary "$install_root/node/lib/node_modules/npm/bin/npm-cli.js" "$HOME/.local/bin/npm"
  link_binary "$install_root/node/lib/node_modules/npm/bin/npx-cli.js" "$HOME/.local/bin/npx"
  link_binary "$install_root/bun/bin/bun" "$HOME/.local/bin/bun"
  link_binary "$install_root/bun/bin/bun" "$HOME/.local/bin/bunx"
  link_binary "$install_root/uv/bin/uv" "$HOME/.local/bin/uv"
  link_binary "$install_root/uv/bin/uvx" "$HOME/.local/bin/uvx"
  link_binary "$install_root/go" "$HOME/.local/go"
  link_binary "$install_root/go/bin/go" "$HOME/.local/bin/go"
  link_binary "$install_root/go/bin/gofmt" "$HOME/.local/bin/gofmt"
  link_binary "$install_root/rust/bin/cargo" "$HOME/.local/bin/cargo"
  prepare_c_compiler "$install_root"
  prepare_rust_linker "$install_root"
}

case "${1:-}" in
  --validate-manifest)
    validate_manifest
    exit 0
    ;;
  --install-only)
    install_toolchain
    exit 0
    ;;
  --)
    shift
    (( $# > 0 )) || fail 'missing Nanoagent command'
    install_toolchain
    exec "$@"
    ;;
  *)
    fail 'expected --validate-manifest, --install-only, or -- COMMAND'
    ;;
esac
