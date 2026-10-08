#!/bin/sh
set -eu
umask 077
/usr/local/bin/tengri-network
chmod 0777 /work
exec setpriv --no-new-privs --reuid=65532 --regid=65532 --groups="$(stat -c %g /dev/kvm)" \
  /fixture/kvm-test --ignored --exact \
  slot::kvm_test::real_guest_restores_files_codex_and_the_same_shell_without_resident_snapshot_pages \
  --nocapture
