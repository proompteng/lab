#!/usr/bin/env bash
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/source" "$work/extracted"
printf '#!/bin/sh\nexit 0\n' > "$work/source/program"
chmod 0755 "$work/source/program"
chown 1000:1000 "$work/source/program"
ln -s program "$work/source/init"
tar -cf "$work/rootfs.tar" -C "$work/source" .
umask 077
tar --extract --preserve-permissions --file "$work/rootfs.tar" --directory "$work/extracted"
cmp "$work/source/program" "$work/extracted/program"
test "$(stat -c '%a:%u:%g' "$work/extracted/program")" = 755:1000:1000
test "$(readlink "$work/extracted/init")" = program
"$work/extracted/init"
