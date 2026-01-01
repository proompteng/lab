terraform {
  required_providers {
    harvester = {
      source  = "harvester/harvester"
      version = "1.7.0"
    }
  }
  backend "pg" {
    conn_str = "postgres://altra:@nuc.lan:5432/altra?sslmode=disable"
  }
}

provider "harvester" {
  kubeconfig = "~/.kube/altra.yaml"
}

locals {
  kube_master_cpu       = 8
  kube_worker_cpu       = 16
  docker_vm_cpu         = 8
  kube_master_memory    = "32Gi"
  kube_worker_memory    = "30Gi"
  docker_vm_memory      = "32Gi"
  kube_node_disk_size   = "200Gi"
  docker_node_disk_size = "100Gi"

  master_mac_addresses = {
    "kube-master-00" = "00:16:3E:3C:0D:00" // 192.168.1.150
    "kube-master-01" = "00:16:3E:3C:0D:01" // 192.168.1.151
    "kube-master-02" = "00:16:3E:3C:0D:02" // 192.168.1.152
  }

  worker_mac_addresses = {
    "kube-worker-00" = "00:16:3E:3C:0E:00" // 192.168.1.160
    "kube-worker-01" = "00:16:3E:3C:0E:01" // 192.168.1.161
    "kube-worker-02" = "00:16:3E:3C:0E:02" // 192.168.1.162
    "kube-worker-03" = "00:16:3E:3C:0E:03" // 192.168.1.163
    "kube-worker-04" = "00:16:3E:3C:0E:04" // 192.168.1.164
    "kube-worker-05" = "00:16:3E:3C:0E:05" // 192.168.1.165
    "kube-worker-06" = "00:16:3E:3C:0E:06" // 192.168.1.166
    "kube-worker-07" = "00:16:3E:3C:0E:07" // 192.168.1.167
    "kube-worker-08" = "00:16:3E:3C:0E:08" // 192.168.1.168
    "kube-worker-09" = "00:16:3E:3C:0E:09" // 192.168.1.169
    "kube-worker-10" = "00:16:3E:3C:0E:0A" // 192.168.1.170
    "kube-worker-11" = "00:16:3E:3C:0E:0B" // 192.168.1.171
    "kube-worker-12" = "00:16:3E:3C:0E:0C" // 192.168.1.172
    "kube-worker-13" = "00:16:3E:3C:0E:0D" // 192.168.1.173
    "kube-worker-14" = "00:16:3E:3C:0E:0E" // 192.168.1.174
    "kube-worker-15" = "00:16:3E:3C:0E:0F" // 192.168.1.175
    "kube-worker-16" = "00:16:3E:3C:0E:10" // 192.168.1.176
    "kube-worker-17" = "00:16:3E:3C:0E:11" // 192.168.1.177
    "kube-worker-18" = "00:16:3E:3C:0E:12" // 192.168.1.178
    "kube-worker-19" = "00:16:3E:3C:0E:13" // 192.168.1.179
    "kube-worker-20" = "00:16:3E:3C:0E:14" // 192.168.1.180
    "kube-worker-21" = "00:16:3E:3C:0E:15" // 192.168.1.181
    "kube-worker-22" = "00:16:3E:3C:0E:16" // 192.168.1.182
    "kube-worker-23" = "00:16:3E:3C:0E:17" // 192.168.1.183
    "kube-worker-24" = "00:16:3E:3C:0E:18" // 192.168.1.184
    "kube-worker-25" = "00:16:3E:3C:0E:19" // 192.168.1.185
    "kube-worker-26" = "00:16:3E:3C:0E:1A" // 192.168.1.186
    "kube-worker-27" = "00:16:3E:3C:0E:1B" // 192.168.1.187
    "kube-worker-28" = "00:16:3E:3C:0E:1C" // 192.168.1.188
    "kube-worker-29" = "00:16:3E:3C:0E:1D" // 192.168.1.189
  }

  vms = merge(
    {
      for name, mac in local.master_mac_addresses :
      name => {
        mac_address = mac
        cpu         = local.kube_master_cpu
        memory      = local.kube_master_memory
      }
    },
    {
      for name, mac in local.worker_mac_addresses :
      name => {
        mac_address = mac
        cpu         = local.kube_worker_cpu
        memory      = local.kube_worker_memory
      }
    }
  )

  docker_vm = {
    "docker-host" = {
      mac_address = "00:16:3E:3C:0F:00" // 192.168.1.190
      cpu         = local.docker_vm_cpu
      memory      = local.docker_vm_memory
    }
  }
}

resource "harvester_image" "ubuntu-noble" {
  name               = "ubuntu-noble"
  display_name       = "Ubuntu 24 Noble LTS"
  source_type        = "download"
  namespace          = "harvester-public"
  url                = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-arm64.img"
  storage_class_name = harvester_storageclass.single-node-longhorn.name

  lifecycle {
    prevent_destroy = true
  }
}

data "harvester_clusternetwork" "mgmt" {
  name = "mgmt"
}

resource "harvester_storageclass" "single-node-longhorn" {
  name               = "single-node-longhorn"
  volume_provisioner = "driver.longhorn.io"
  is_default         = true

  parameters = {
    "migratable"          = "true"
    "numberOfReplicas"    = "1"
    "staleReplicaTimeout" = "30"
  }
  reclaim_policy         = "Delete"
  allow_volume_expansion = true
  volume_binding_mode    = "Immediate"
}

resource "harvester_network" "cluster_network" {
  cluster_network_name = data.harvester_clusternetwork.mgmt.name
  name                 = "cluster-network"
  vlan_id              = 1
}

resource "harvester_virtualmachine" "kube-cluster" {
  for_each = local.vms
  name     = each.key
  cpu      = each.value.cpu
  memory   = each.value.memory

  efi          = true
  hostname     = each.key
  run_strategy = "Always"

  disk {
    name        = "root"
    type        = "disk"
    size        = local.kube_node_disk_size
    bus         = "virtio"
    boot_order  = 1
    image       = harvester_image.ubuntu-noble.id
    auto_delete = true
  }


  network_interface {
    name           = "bridge"
    model          = "virtio"
    type           = "bridge"
    mac_address    = each.value.mac_address
    network_name   = harvester_network.cluster_network.name
    wait_for_lease = true
  }

  cloudinit {
    user_data_secret_name    = harvester_cloudinit_secret.ubuntu-plain.name
    network_data_secret_name = harvester_cloudinit_secret.ubuntu-plain.name
  }

  timeouts {
    create = "30m"
    update = "30m"
    delete = "30m"
  }

  ssh_keys = [
    harvester_ssh_key.public-key.id
  ]
}

resource "harvester_ssh_key" "public-key" {
  name      = "1password"
  namespace = "default"

  public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDVYPSSdt6tjSWRooRm7nUDS73CebsP92G6GjFa9X+zy"
}

# https://github.com/harvester/harvester/issues/4739 ~ Disable fstrim
resource "harvester_cloudinit_secret" "ubuntu-plain" {
  name = "ubuntu-plain"

  user_data    = <<-EOF
#cloud-config
ssh_authorized_keys:
  - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIZ/qbQDkfh+J3eZvJnpScECqBxKuovpS88mHaQlLt7z
  - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOE//lpGZI2015yMUjHwhWJjgarTLIsqQBIFXlAanPvS
  - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDVYPSSdt6tjSWRooRm7nUDS73CebsP92G6GjFa9X+zy
package_update: true
package_upgrade: true
package_reboot_if_required: true
bootcmd:
  - sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="/&discard=off /' /etc/default/grub
  - sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="/&transparent_hugepage=never /' /etc/default/grub
  - update-grub
packages:
  - qemu-guest-agent
  - curl
  - chrony
  - ethtool
  - nfs-common
write-files:
  - path: /etc/sysctl.d/60-k8s-perf.conf
    content: |
      fs.inotify.max_user_watches = 1048576
      fs.inotify.max_user_instances = 8192
      fs.file-max = 2097152
      vm.max_map_count = 524288
      vm.swappiness = 0
      kernel.numa_balancing = 0
      net.core.somaxconn = 4096
      net.core.netdev_max_backlog = 250000
      net.core.rmem_max = 134217728
      net.core.wmem_max = 134217728
      net.ipv4.tcp_rmem = 4096 87380 134217728
      net.ipv4.tcp_wmem = 4096 65536 134217728
      net.ipv4.tcp_congestion_control = bbr
      net.ipv4.ip_forward = 1
      net.ipv4.neigh.default.gc_thresh1 = 4096
      net.ipv4.neigh.default.gc_thresh2 = 8192
      net.ipv4.neigh.default.gc_thresh3 = 16384
      net.ipv4.conf.all.rp_filter = 0
      net.ipv4.conf.default.rp_filter = 0
      net.bridge.bridge-nf-call-iptables = 1
  - path: /etc/udev/rules.d/60-scheduler-nvme.rules
    content: |
      # Set I/O scheduler to 'none' for NVMe devices
      ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/scheduler}="none"
  - path: /etc/systemd/system/fstrim.timer.d/override.conf
    content: |
      [Timer]
      OnCalendar=
  - path: /etc/systemd/system/fstrim.service.d/override.conf
    content: |
      [Service]
      ExecStart=
  - path: /etc/systemd/system/cpu-performance.service
    content: |
      [Unit]
      Description=Set CPU governor to performance
      After=multi-user.target

      [Service]
      Type=oneshot
      ExecStart=/bin/sh -c 'for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do [ -f "$g" ] && echo performance > "$g" || true; done'

      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/disable-thp.service
    content: |
      [Unit]
      Description=Disable Transparent Huge Pages
      After=multi-user.target

      [Service]
      Type=oneshot
      ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled; echo never > /sys/kernel/mm/transparent_hugepage/defrag'
      RemainAfterExit=yes

      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/journald.conf.d/99-performance.conf
    content: |
      [Journal]
      SystemMaxUse=1G
      RuntimeMaxUse=1G
  - path: /usr/local/sbin/nic-tune.sh
    permissions: '0755'
    content: |
      #!/bin/sh
      set -eu
      for IFACE in $(ls /sys/class/net); do
        [ "$IFACE" = "lo" ] && continue
        ethtool -K "$IFACE" gro on gso on tso on 2>/dev/null || true
      done
  - path: /etc/systemd/system/nic-tune.service
    content: |
      [Unit]
      Description=Tune NIC offloads for performance
      Wants=network-online.target
      After=network-online.target

      [Service]
      Type=oneshot
      ExecStart=/usr/local/sbin/nic-tune.sh

      [Install]
      WantedBy=multi-user.target
runcmd:
  - systemctl daemon-reload
  - systemctl enable --now qemu-guest-agent
  - systemctl mask fstrim.timer
  - systemctl stop fstrim.timer
  - systemctl mask fstrim.service
  - systemctl stop fstrim.service
  - sysctl --system
  - udevadm control --reload-rules
  - udevadm trigger
  - modprobe br_netfilter || true
  - swapoff -a
  - sed -ri 's/^(\S+\s+\S+\s+swap\s+\S+\s+\S+\s*\S*)/# \1/g' /etc/fstab
  - systemctl enable --now cpu-performance.service
  - systemctl enable --now disable-thp.service
  - systemctl enable --now nic-tune.service
  - systemctl restart systemd-journald
  # Install Tailscale
  - curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  - curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list
  - apt-get update
  - apt-get install -y tailscale
  - systemctl enable --now tailscaled
# bootcmd removed (daemon-reload moved to runcmd)
users:
  - name: kalmyk
    groups: [adm, cdrom, dip, plugdev, lxd, sudo]
    lock_passwd: false
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    no_ssh_fingerprints: false
    ssh:
      emit_keys_to_console: false
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIZ/qbQDkfh+J3eZvJnpScECqBxKuovpS88mHaQlLt7z
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOE//lpGZI2015yMUjHwhWJjgarTLIsqQBIFXlAanPvS
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDVYPSSdt6tjSWRooRm7nUDS73CebsP92G6GjFa9X+zy
EOF
  network_data = ""
}

resource "harvester_cloudinit_secret" "ubuntu-docker" {
  name = "ubuntu-cloud-config"

  user_data    = <<-EOF
#cloud-config
package_update: true
package_upgrade: true
package_reboot_if_required: true
packages:
  - qemu-guest-agent
  - curl
  - nfs-common
runcmd:
  - systemctl enable --now qemu-guest-agent
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  - chmod a+r /etc/apt/keyrings/docker.gpg
  - |
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null
  - apt-get update
  - apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y
  - systemctl enable --now docker
  # Install Tailscale
  - curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  - curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list
  - apt-get update
  - apt-get install -y tailscale
  - systemctl enable --now tailscaled
  - echo 'alias k=kubectl' >> /home/kalmyk/.bashrc
  - mkdir -p /home/kalmyk/.ssh && chmod 700 /home/kalmyk/.ssh
  - touch /home/kalmyk/.ssh/authorized_keys && chmod 600 /home/kalmyk/.ssh/authorized_keys
  - curl https://github.com/gregkonush.keys -o /home/kalmyk/.ssh/authorized_keys
groups:
  - docker
users:
  - name: kalmyk
    groups: [adm, cdrom, dip, plugdev, lxd, sudo, docker]
    lock_passwd: false
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    no_ssh_fingerprints: false
    ssh:
      emit_keys_to_console: false
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIZ/qbQDkfh+J3eZvJnpScECqBxKuovpS88mHaQlLt7z
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDVYPSSdt6tjSWRooRm7nUDS73CebsP92G6GjFa9X+zy
EOF
  network_data = ""
}

resource "harvester_virtualmachine" "docker-host" {
  for_each = local.docker_vm
  name     = each.key
  cpu      = each.value.cpu
  memory   = each.value.memory

  efi          = true
  hostname     = each.key
  run_strategy = "Always"

  disk {
    name        = "root"
    type        = "disk"
    size        = local.docker_node_disk_size
    bus         = "virtio"
    boot_order  = 1
    image       = harvester_image.ubuntu-noble.id
    auto_delete = true
  }

  network_interface {
    name           = "bridge"
    model          = "virtio"
    type           = "bridge"
    mac_address    = each.value.mac_address
    network_name   = harvester_network.cluster_network.name
    wait_for_lease = true
  }

  cloudinit {
    user_data_secret_name    = harvester_cloudinit_secret.ubuntu-docker.name
    network_data_secret_name = harvester_cloudinit_secret.ubuntu-docker.name
  }

  timeouts {
    create = "30m"
    update = "30m"
    delete = "30m"
  }

  ssh_keys = [
    harvester_ssh_key.public-key.id
  ]
}
