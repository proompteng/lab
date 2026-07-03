# Altra BMC and IPMI

This runbook records the out-of-band management address for the Altra Talos
node and the safe read-only IPMI commands to verify access.

## Identity

- BMC/IPMI address: `192.168.0.100`
- BMC subnet: `192.168.0.0/24`
- IPMI user: `admin`
- Talos node name: `talos-192-168-1-85`
- Legacy Talos LAN address: `192.168.1.85`
- Current Talos/Tailscale endpoint: `100.100.244.142`

Do not confuse the BMC address with the Talos node addresses. The BMC does not
answer on the `100.100.244.128/25` provider-managed/Tailscale network; reach it
on the default BMC subnet.

## Authentication

Do not put the BMC password on the command line. `ipmitool` reads the password
from `IPMI_PASSWORD` when `-E` is passed.

```bash
export IPMI_PASSWORD='...'

ipmitool -I lanplus -H 192.168.0.100 -U admin -E chassis power status
```

## Temporary macOS reachability

If the workstation is not already on `192.168.0.0/24`, add a temporary address
alias to the connected interface before using IPMI or the BMC web UI:

```bash
sudo ifconfig en0 alias 192.168.0.10 255.255.255.0
ping -c 3 192.168.0.100
```

Remove the alias when finished:

```bash
sudo ifconfig en0 -alias 192.168.0.10
```

Use the actual active interface if it is not `en0`.

## Read-only checks

```bash
ipmitool -I lanplus -H 192.168.0.100 -U admin -E chassis power status
ipmitool -I lanplus -H 192.168.0.100 -U admin -E sdr elist
ipmitool -I lanplus -H 192.168.0.100 -U admin -E sel elist | tail -n 50
```

## Power control

Use power control only after checking Kubernetes, etcd, and Ceph safety gates.
For Talos maintenance, prefer `talosctl reboot` or `talosctl shutdown` while the
Talos API is healthy.

```bash
# Power on
ipmitool -I lanplus -H 192.168.0.100 -U admin -E chassis power on

# Graceful ACPI shutdown request
ipmitool -I lanplus -H 192.168.0.100 -U admin -E chassis power soft

# Warm reset
ipmitool -I lanplus -H 192.168.0.100 -U admin -E chassis power reset

# Forced power off; use only during explicit recovery
ipmitool -I lanplus -H 192.168.0.100 -U admin -E chassis power off
```

## One-time boot override

```bash
# Boot into BIOS setup on next boot
ipmitool -I lanplus -H 192.168.0.100 -U admin -E chassis bootdev bios

# Boot from virtual CD/DVD on next boot
ipmitool -I lanplus -H 192.168.0.100 -U admin -E chassis bootdev cdrom

# PXE on next boot
ipmitool -I lanplus -H 192.168.0.100 -U admin -E chassis bootdev pxe
```

Then reboot through the safest available path.

## Serial-over-LAN

```bash
ipmitool -I lanplus -H 192.168.0.100 -U admin -E sol activate
```

Exit SOL with `~.` on a new line. If the default SOL channel does not work,
inspect BMC channel settings before trying board-specific bridge options.

## Safety notes

- Do not commit BMC credentials.
- Do not reset or power-cycle Altra during Ceph recovery unless the Talos node
  is already failed and a separate recovery decision has been made.
- Before planned Talos work, capture `kubectl get nodes`, etcd members,
  `ceph -s`, and a server-side drain dry-run.
