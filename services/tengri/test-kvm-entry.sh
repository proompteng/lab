#!/bin/sh
set -eu
umask 077
: "${TENGRI_KVM_NETWORK_MTU:?set the execution network MTU}"
case "$TENGRI_KVM_NETWORK_MTU" in
  *[!0-9]*|'') echo 'KVM fixture requires a valid IPv4 interface MTU' >&2; exit 1 ;;
esac
if [ "$TENGRI_KVM_NETWORK_MTU" -lt 576 ] || [ "$TENGRI_KVM_NETWORK_MTU" -gt 65535 ]; then
  echo 'KVM fixture interface MTU is outside the IPv4 range' >&2
  exit 1
fi
test_name=slot::kvm_test::real_guest_restores_files_codex_and_the_same_shell_without_resident_snapshot_pages
tests="$(/fixture/kvm-test --list --ignored)"
if ! printf '%s\n' "$tests" | grep -Fx "$test_name: test" >/dev/null; then
  echo 'KVM fixture binary is missing the required native lifecycle test' >&2
  exit 1
fi
ip link set dev eth0 mtu "$TENGRI_KVM_NETWORK_MTU"
/usr/local/bin/tengri-network
chmod 0777 /work
exec setpriv --no-new-privs --reuid=65532 --regid=65532 --groups="$(stat -c %g /dev/kvm)" \
  /fixture/kvm-test --ignored --exact \
  "$test_name" \
  --nocapture
