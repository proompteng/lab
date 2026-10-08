#!/bin/sh
set -eu
umask 077
: "${TENGRI_KVM_NETWORK_MTU:?set the execution network MTU}"
case "$TENGRI_KVM_NETWORK_MTU" in
  *[!0-9]*|'') echo 'KVM fixture requires a valid IPv4 interface MTU' >&2; exit 1 ;;
esac
[ "$TENGRI_KVM_NETWORK_MTU" -ge 576 ] && [ "$TENGRI_KVM_NETWORK_MTU" -le 65535 ]
ip link set dev eth0 mtu "$TENGRI_KVM_NETWORK_MTU"
/usr/local/bin/tengri-network
chmod 0777 /work
exec setpriv --no-new-privs --reuid=65532 --regid=65532 --groups="$(stat -c %g /dev/kvm)" \
  /fixture/kvm-test --ignored --exact \
  slot::kvm_test::real_guest_restores_files_codex_and_the_same_shell_without_resident_snapshot_pages \
  --nocapture
