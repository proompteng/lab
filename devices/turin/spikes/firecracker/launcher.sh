#!/usr/bin/env bash
set -Eeuo pipefail

readonly firecracker_version='v1.16.1'
readonly firecracker_archive_sha256='382a02a869e4d6d5cb14c40577f9545e8458021ea8b0b2d3fc10ec14d9c242e6'
readonly artifact_prefix='https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20260819-0a745def42dd-0/x86_64'
readonly kernel_name='vmlinux-6.18.41'
readonly kernel_sha256='645688b5933cb257f7d4fa71eb246669233e8c2db8378217c99cf891541fe3d5'
readonly rootfs_name='ubuntu-24.04.squashfs'
readonly rootfs_sha256='2ee9cfdea73468b2fa9cd772cc3a70e89beeb78195ab3f0bad225a2368ef6b08'
readonly vm_id="${MICROVM_ID:-turin-fc-spike}"
readonly jail_uid='30000'
readonly jail_gid='30000'
readonly bootstrap_nonce='turin-firecracker-spike-v1'
readonly jail_base='/work/jailer'
readonly jail_root="${jail_base}/firecracker/${vm_id}/root"
readonly api_socket="${jail_root}/run/firecracker.socket"
readonly vsock_socket="${jail_root}/run/vsock"

jailer_pid=''
firecracker_pid=''
tail_pid=''
callback_pid=''
tap_created='false'
nat_created='false'
forward_out_created='false'
forward_in_created='false'
host_interface=''

log() {
  printf 'SPIKE %s\n' "$*"
}

process_is_running() {
  local pid="$1"
  local _pid _name state _rest
  if [[ ! -r "/proc/${pid}/stat" ]]; then
    return 1
  fi
  read -r _pid _name state _rest <"/proc/${pid}/stat"
  [[ "${state}" != 'Z' ]]
}

cleanup() {
  set +e
  rm -f /work/microvm-ready
  if [[ -n "${firecracker_pid}" ]] && process_is_running "${firecracker_pid}"; then
    kill "${firecracker_pid}" 2>/dev/null
    for _ in $(seq 1 20); do
      if ! process_is_running "${firecracker_pid}"; then
        break
      fi
      sleep 0.1
    done
    if process_is_running "${firecracker_pid}"; then
      kill -KILL "${firecracker_pid}" 2>/dev/null
    fi
  fi
  if [[ -n "${jailer_pid}" ]] && kill -0 "${jailer_pid}" 2>/dev/null; then
    kill "${jailer_pid}" 2>/dev/null
    wait "${jailer_pid}" 2>/dev/null
  fi
  if [[ -n "${tail_pid}" ]] && kill -0 "${tail_pid}" 2>/dev/null; then
    kill "${tail_pid}" 2>/dev/null
  fi
  if [[ -n "${callback_pid}" ]] && kill -0 "${callback_pid}" 2>/dev/null; then
    kill "${callback_pid}" 2>/dev/null
  fi
  if [[ "${forward_in_created}" == 'true' ]]; then
    iptables --wait --delete FORWARD --in-interface "${host_interface}" --out-interface tap0 \
      --match conntrack --ctstate ESTABLISHED,RELATED --jump ACCEPT 2>/dev/null
  fi
  if [[ "${forward_out_created}" == 'true' ]]; then
    iptables --wait --delete FORWARD --in-interface tap0 --out-interface "${host_interface}" \
      --jump ACCEPT 2>/dev/null
  fi
  if [[ "${nat_created}" == 'true' ]]; then
    iptables --wait --table nat --delete POSTROUTING --source 172.16.0.0/30 \
      --out-interface "${host_interface}" --jump MASQUERADE 2>/dev/null
  fi
  if [[ "${tap_created}" == 'true' ]]; then
    ip link delete tap0 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

download() {
  local url="$1"
  local destination="$2"
  curl --fail --location --silent --show-error \
    --retry 5 --retry-all-errors --retry-delay 2 \
    --output "${destination}" "${url}"
}

wait_for_file() {
  local path="$1"
  local attempts="$2"
  for _ in $(seq 1 "${attempts}"); do
    if [[ -s "${path}" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

fc_put() {
  local path="$1"
  local payload="$2"
  curl --fail-with-body --silent --show-error \
    --unix-socket "${api_socket}" \
    --request PUT \
    --header 'Content-Type: application/json' \
    --data "${payload}" \
    "http://localhost${path}"
}

log 'phase=host-preflight'
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]]
[[ -c /dev/net/tun && -r /dev/net/tun && -w /dev/net/tun ]]
grep -q $'cgroup2' /proc/filesystems
grep -qE '^flags.*\b(svm|vmx)\b' /proc/cpuinfo
log "host-preflight=ok node=${NODE_NAME:-unknown} arch=$(uname -m) kernel=$(uname -r)"
log "pod-cgroup=$(tr '\n' ',' </proc/self/cgroup)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl e2fsprogs iproute2 iptables openssh-client procps python3 squashfs-tools \
  >/work/apt-install.log
rm -rf /var/lib/apt/lists/*

log 'phase=download-verified-artifacts'
download \
  "https://github.com/firecracker-microvm/firecracker/releases/download/${firecracker_version}/firecracker-${firecracker_version}-x86_64.tgz" \
  /work/firecracker.tgz
printf '%s  %s\n' "${firecracker_archive_sha256}" /work/firecracker.tgz | sha256sum --check

tar -xzf /work/firecracker.tgz -C /work
install -m 0755 \
  "/work/release-${firecracker_version}-x86_64/firecracker-${firecracker_version}-x86_64" \
  /usr/local/bin/firecracker
install -m 0755 \
  "/work/release-${firecracker_version}-x86_64/jailer-${firecracker_version}-x86_64" \
  /usr/local/bin/jailer

download "${artifact_prefix}/${kernel_name}" "/work/${kernel_name}"
download "${artifact_prefix}/${rootfs_name}" "/work/${rootfs_name}"
printf '%s  %s\n' "${kernel_sha256}" "/work/${kernel_name}" | sha256sum --check
printf '%s  %s\n' "${rootfs_sha256}" "/work/${rootfs_name}" | sha256sum --check
log "firecracker-version=$(/usr/local/bin/firecracker --version)"

log 'phase=build-agent-rootfs'
unsquashfs -no-progress -d /work/rootfs-tree "/work/${rootfs_name}"

ssh-keygen -q -t ed25519 -N '' -f /work/id_ed25519
install -d -m 0700 /work/rootfs-tree/root/.ssh
install -m 0600 /work/id_ed25519.pub /work/rootfs-tree/root/.ssh/authorized_keys
install -m 0755 /spike/guest-agent.sh /work/rootfs-tree/usr/local/bin/microvm-agent
install -m 0755 /spike/guest-control.py /work/rootfs-tree/usr/local/bin/microvm-control
install -m 0644 /spike/microvm-agent.service /work/rootfs-tree/etc/systemd/system/microvm-agent.service
install -m 0644 /spike/microvm-control.service /work/rootfs-tree/etc/systemd/system/microvm-control.service
install -d -m 0755 /work/rootfs-tree/etc/systemd/system/multi-user.target.wants
ln -s ../microvm-agent.service \
  /work/rootfs-tree/etc/systemd/system/multi-user.target.wants/microvm-agent.service
ln -s ../microvm-control.service \
  /work/rootfs-tree/etc/systemd/system/multi-user.target.wants/microvm-control.service
ln -sf /usr/lib/systemd/system/ssh.service \
  /work/rootfs-tree/etc/systemd/system/multi-user.target.wants/ssh.service
install -d -m 0755 /work/rootfs-tree/etc/ssh/sshd_config.d
printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\n' \
  >/work/rootfs-tree/etc/ssh/sshd_config.d/99-microvm-spike.conf
cp /etc/resolv.conf /work/rootfs-tree/etc/resolv.conf
ssh-keygen -q -A -f /work/rootfs-tree

truncate --size 1G /work/rootfs.ext4
mkfs.ext4 -q -F -d /work/rootfs-tree /work/rootfs.ext4
e2fsck -fn /work/rootfs.ext4 >/work/e2fsck.txt
log 'rootfs=ok agent=systemd ssh=key-only'

log 'phase=configure-pod-network'
ip tuntap add dev tap0 mode tap user "${jail_uid}"
tap_created='true'
ip address add 172.16.0.1/30 dev tap0
ip link set tap0 up
printf '1' >/proc/sys/net/ipv4/ip_forward
host_interface="$(ip -json route show default | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["dev"])')"
iptables --wait --table nat --append POSTROUTING --source 172.16.0.0/30 \
  --out-interface "${host_interface}" --jump MASQUERADE
nat_created='true'
iptables --wait --append FORWARD --in-interface tap0 --out-interface "${host_interface}" --jump ACCEPT
forward_out_created='true'
iptables --wait --append FORWARD --in-interface "${host_interface}" --out-interface tap0 \
  --match conntrack --ctstate ESTABLISHED,RELATED --jump ACCEPT
forward_in_created='true'
EXPECTED_NONCE="${bootstrap_nonce}" python3 /spike/host-callback.py &
callback_pid="$!"
log "tap=ok host_interface=${host_interface} guest=172.16.0.2/30"

log 'phase=launch-jailed-firecracker'
install -d -o root -g root -m 0750 "${jail_root}"
install -d -o "${jail_uid}" -g "${jail_gid}" -m 0750 "${jail_root}/run"
install -o root -g "${jail_gid}" -m 0440 "/work/${kernel_name}" "${jail_root}/vmlinux"
install -o root -g "${jail_gid}" -m 0660 /work/rootfs.ext4 "${jail_root}/rootfs.ext4"

/usr/local/bin/jailer \
  --id "${vm_id}" \
  --exec-file /usr/local/bin/firecracker \
  --uid "${jail_uid}" \
  --gid "${jail_gid}" \
  --chroot-base-dir "${jail_base}" \
  --cgroup-version 2 \
  --resource-limit no-file=1024 \
  --new-pid-ns \
  -- \
  --api-sock /run/firecracker.socket \
  >/work/firecracker-serial.log 2>&1 &
jailer_pid="$!"
touch /work/firecracker-serial.log
tail --pid="${jailer_pid}" -F /work/firecracker-serial.log &
tail_pid="$!"

for _ in $(seq 1 30); do
  if [[ -S "${api_socket}" ]]; then
    break
  fi
  if ! kill -0 "${jailer_pid}" 2>/dev/null; then
    log 'jailer-exited-before-api-socket'
    wait "${jailer_pid}"
  fi
  sleep 1
done
[[ -S "${api_socket}" ]]

fc_put '/machine-config' '{"vcpu_count":1,"mem_size_mib":256,"smt":false,"track_dirty_pages":false}'
fc_put '/boot-source' \
  '{"kernel_image_path":"/vmlinux","boot_args":"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw"}'
fc_put '/drives/rootfs' \
  '{"drive_id":"rootfs","path_on_host":"/rootfs.ext4","is_root_device":true,"is_read_only":false,"cache_type":"Unsafe","io_engine":"Sync"}'
fc_put '/network-interfaces/eth0' \
  '{"iface_id":"eth0","guest_mac":"06:00:AC:10:00:02","host_dev_name":"tap0"}'
fc_put '/vsock' '{"guest_cid":3,"uds_path":"/run/vsock"}'
fc_put '/mmds/config' \
  '{"version":"V2","network_interfaces":["eth0"],"ipv4_address":"169.254.169.254"}'
fc_put '/mmds' \
  "{\"bootstrap\":{\"nonce\":\"${bootstrap_nonce}\",\"controller-url\":\"http://172.16.0.1:8080/ready\",\"microvm-id\":\"${vm_id}\"}}"
fc_put '/actions' '{"action_type":"InstanceStart"}'
log 'firecracker-instance-started'

if ! wait_for_file /work/agent-callback.json 120; then
  log 'agent-callback-timeout'
  exit 1
fi

readonly ssh_options=(
  -i /work/id_ed25519
  -o BatchMode=yes
  -o ConnectTimeout=2
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
)
for _ in $(seq 1 60); do
  if ssh "${ssh_options[@]}" root@172.16.0.2 true >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
ssh "${ssh_options[@]}" root@172.16.0.2 true

guest_ready="$(ssh "${ssh_options[@]}" root@172.16.0.2 cat /run/microvm-agent.ready)"
guest_kernel="$(ssh "${ssh_options[@]}" root@172.16.0.2 uname -r)"
guest_identity="$(ssh "${ssh_options[@]}" root@172.16.0.2 id -u)"
callback="$(cat /work/agent-callback.json)"
readonly guest_ready guest_kernel guest_identity callback
log "agent-callback=${callback}"
if [[ "${callback}" != *'"mmds_v2":"ok"'* || "${guest_ready}" != *'"mmds_v2":"ok"'* ]]; then
  log 'assertion-failed=mmds-v2-bootstrap'
  ssh "${ssh_options[@]}" root@172.16.0.2 journalctl --unit microvm-agent --no-pager --lines 50 || true
  exit 1
fi
if [[ "${callback}" != *'"network_egress":"ok"'* || "${guest_ready}" != *'"network_egress":"ok"'* ]]; then
  log 'assertion-failed=guest-network-egress'
  ssh "${ssh_options[@]}" root@172.16.0.2 ip route || true
  ssh "${ssh_options[@]}" root@172.16.0.2 cat /etc/resolv.conf || true
  ssh "${ssh_options[@]}" root@172.16.0.2 \
    curl --ipv4 --verbose --max-time 15 --output /dev/null https://aws.amazon.com/firecracker/ || true
  exit 1
fi

vsock_response=''
for _ in $(seq 1 30); do
  if vsock_response="$(python3 /spike/host-vsock-client.py "${vsock_socket}" 2>/dev/null)"; then
    break
  fi
  sleep 1
done
if [[ "${vsock_response}" != *'"control": "vsock"'* ]]; then
  log "assertion-failed=vsock-control socket=$(ls -l "${vsock_socket}" 2>&1 || true)"
  ssh "${ssh_options[@]}" root@172.16.0.2 systemctl status microvm-control --no-pager || true
  ssh "${ssh_options[@]}" root@172.16.0.2 journalctl --unit microvm-control --no-pager --lines 50 || true
  exit 1
fi

firecracker_pid="$(cat "${jail_root}/firecracker.pid")"
firecracker_status="$(grep -E '^(Name|Pid|PPid|Uid|Gid|NoNewPrivs|Seccomp):' "/proc/${firecracker_pid}/status" | tr '\n' ',')"
firecracker_cgroup="$(tr '\n' ',' <"/proc/${firecracker_pid}/cgroup")"
firecracker_root="$(readlink "/proc/${firecracker_pid}/root")"
instance_info="$(curl --fail --silent --show-error --unix-socket "${api_socket}" http://localhost/)"
readonly firecracker_pid firecracker_status firecracker_cgroup firecracker_root instance_info

log "proof=guest-boot kernel=${guest_kernel} uid=${guest_identity}"
log "proof=agent-bootstrap callback=${callback} guest-ready=${guest_ready}"
log "proof=host-guest-control response=${vsock_response}"
log "proof=jailer pid=${firecracker_pid} root=${firecracker_root} status=${firecracker_status}"
log "proof=resource-accounting pod-cgroup=$(tr '\n' ',' </proc/self/cgroup) firecracker-cgroup=${firecracker_cgroup} config=1vcpu-256MiB pod-limit=2cpu-4GiB"
log "proof=instance-info ${instance_info}"
log 'result=PASS'

printf '%s\n' "${firecracker_pid}" >/work/microvm-ready
if [[ "${KEEP_VM_RUNNING:-false}" == 'true' ]]; then
  log "state=RUNNING microvm_id=${vm_id} firecracker_pid=${firecracker_pid}"
  while process_is_running "${firecracker_pid}"; do
    sleep 5
  done
  log "state=STOPPED microvm_id=${vm_id} reason=firecracker-process-exited"
  exit 1
fi

fc_put '/actions' '{"action_type":"SendCtrlAltDel"}' || true
sleep 2
