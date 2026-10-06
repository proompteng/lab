#!/usr/bin/env bash
set -euo pipefail

# Match configureToolchainEnvironment so C++ subprocesses find Homebrew binutils.
export PATH="$HOME/.local/bin:$HOME/.linuxbrew/bin:$HOME/.linuxbrew/sbin:$PATH"

readonly prefix="$HOME/.linuxbrew"
readonly receipt="$HOME/.local/share/nanoagent/developer-tools-ready"
work="$(mktemp -d "$HOME/.cache/developer-tools-test.XXXXXX")"
readonly work
readonly bootstrap="${1:-/usr/local/bin/bootstrap-developer-tools}"

cleanup() {
  if [[ -e "$work/g++" ]]; then
    mv -f -- "$work/g++" "$HOME/.local/bin/g++"
  fi
  if [[ -e "$work/go" || -L "$work/go" ]]; then
    rm -f -- "$HOME/.local/go"
    mv -- "$work/go" "$HOME/.local/go"
  fi
  local command
  for command in brew nvim fd; do
    if [[ -e "$work/$command" || -L "$work/$command" ]]; then
      rm -f -- "$prefix/bin/$command"
      mv -- "$work/$command" "$prefix/bin/$command"
    fi
  done
  cp -- "$work/receipt" "$receipt"
  rm -rf -- "$work"
}

# Prime the current XDG paths after other retained-home fixtures.
"$bootstrap" --install-only
test -s "$receipt"
cp -- "$receipt" "$work/receipt"
trap cleanup EXIT
for command in brew nvim; do
  mv -- "$prefix/bin/$command" "$work/$command"
  printf '#!/usr/bin/env bash\nexit 97\n' > "$prefix/bin/$command"
  chmod 0755 "$prefix/bin/$command"
done

# Prepared homes must not spawn either package manager or editor on resume.
"$bootstrap" --install-only
cmp -- "$receipt" "$work/receipt"

printf 'outdated installation\n' > "$receipt"
if "$bootstrap" --install-only; then
  printf 'An outdated receipt incorrectly skipped offline validation\n' >&2
  exit 1
fi
test ! -e "$receipt"

cp -- "$work/receipt" "$receipt"
mv -- "$prefix/bin/fd" "$work/fd"
if "$bootstrap" --install-only; then
  printf 'A missing executable incorrectly skipped offline repair and validation\n' >&2
  exit 1
fi
test ! -e "$receipt"
test -x "$prefix/bin/fd"
mv -f -- "$work/fd" "$prefix/bin/fd"
# The failed validation deliberately leaves an interrupted-seed marker. Restore
# this fixture's original state so later cases isolate their own invalidation.
test -f "$HOME/.tengri/developer-tools-seed.pending"
rm -- "$HOME/.tengri/developer-tools-seed.pending"

cp -- "$work/receipt" "$receipt"
mv -- "$HOME/.local/bin/g++" "$work/g++"
printf '#!/usr/bin/env bash\nexit 97\n' > "$HOME/.local/bin/g++"
chmod 0755 "$HOME/.local/bin/g++"
cp -- "$HOME/.local/bin/g++" "$work/custom-g++"
if "$bootstrap" --install-only; then
  printf 'A stale C++ wrapper incorrectly reused its receipt\n' >&2
  exit 1
fi
test ! -e "$receipt"
cmp -- "$work/custom-g++" "$HOME/.local/bin/g++"
mv -f -- "$work/g++" "$HOME/.local/bin/g++"

cp -- "$work/receipt" "$receipt"
ln -sfn "$prefix/bin/fd" "$HOME/.local/bin/c++"
if "$bootstrap" --install-only; then
  printf 'An unrelated c++ target incorrectly reused its receipt\n' >&2
  exit 1
fi
test ! -e "$receipt"
test "$(readlink "$HOME/.local/bin/c++")" = "$prefix/bin/fd"
ln -sfn "$HOME/.local/bin/g++" "$HOME/.local/bin/c++"

# The exact former managed wrapper is refreshed without running Homebrew.
cp -- "$work/receipt" "$receipt"
cp -- "$HOME/.local/bin/g++" "$work/g++"
compiler=("$prefix"/opt/gcc/bin/g++-*)
c_root="$(dirname "$(readlink -f "$HOME/.local/go")")/c"
case "$(uname -m)" in x86_64) triplet=x86_64-linux-gnu ;; *) triplet=aarch64-linux-gnu ;; esac
printf '#!/usr/bin/env bash\nexec %q --sysroot=%q -idirafter %q -idirafter %q -B%q "$@"\n' \
  "${compiler[0]}" "$c_root/sysroot" "$c_root/sysroot/usr/include" \
  "$c_root/sysroot/usr/include/$triplet" "$c_root/sysroot/usr/lib/$triplet/" > "$HOME/.local/bin/g++"
if "$bootstrap" --install-only; then
  printf 'A former managed wrapper incorrectly reused its receipt\n' >&2
  exit 1
fi
test ! -e "$receipt"
cmp -- "$work/g++" "$HOME/.local/bin/g++"
rm -- "$work/g++"

cp -- "$work/receipt" "$receipt"
if XDG_CONFIG_HOME="$work/config" "$bootstrap" --install-only; then
  printf 'A different Neovim configuration incorrectly reused its receipt\n' >&2
  exit 1
fi
test ! -e "$receipt"

cp -- "$work/receipt" "$receipt"
mv -- "$HOME/.local/go" "$work/go"
original_c_root="$(dirname "$(readlink -f "$work/go")")/c"
mkdir -p "$work/toolchain/go"
ln -s "$original_c_root" "$work/toolchain/c"
cp -- "$HOME/.local/bin/g++" "$work/g++"
ln -s "$work/toolchain/go" "$HOME/.local/go"
if "$bootstrap" --install-only; then
  printf 'A different toolchain incorrectly reused its C++ wrapper receipt\n' >&2
  exit 1
fi
test ! -e "$receipt"
# The invalid cache already refreshed the managed wrapper without an installer.
grep -F -- "--sysroot=$work/toolchain/c/sysroot" "$HOME/.local/bin/g++"
rm -f -- "$prefix/bin/nvim"
mv -- "$work/nvim" "$prefix/bin/nvim"
"$bootstrap" --install-only
test -s "$receipt"
printf '#include <iostream>\nint main(){std::cout << "cpp-cache-ok";}\n' > "$work/cpp.cpp"
"$HOME/.local/bin/g++" "$work/cpp.cpp" -o "$work/cpp"
test "$("$work/cpp")" = cpp-cache-ok
# A repaired readiness receipt must again skip the editor.
mv -- "$prefix/bin/nvim" "$work/nvim"
printf '#!/usr/bin/env bash\nexit 97\n' > "$prefix/bin/nvim"
chmod 0755 "$prefix/bin/nvim"
"$bootstrap" --install-only
printf 'Prepared homes skip installers and editors; stale, incomplete, and changed-toolchain homes require successful offline validation.\n'
