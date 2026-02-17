# IPMI cookbook (ampone)

Target BMC:
- `192.168.1.224`

Talos node IP (example):
- `192.168.1.203`

## Authentication

Avoid putting the password on the command line. `ipmitool` can read it from the
`IPMI_PASSWORD` environment variable when you pass `-E`.

```bash
export IPMI_PASSWORD='...'

ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power status
```

## Power control

```bash
# Query
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power status

# On/off
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power on
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power off

# Warm reset (not a cold power cycle)
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power reset

# Cold restart (recommended for flaky DDR training): off -> wait -> on
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power off
sleep 30
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power on
```

## One-time boot override

```bash
# Boot into BIOS setup on next boot
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis bootdev bios

# Boot from virtual CD/DVD (BMC virtual media) on next boot
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis bootdev cdrom

# PXE on next boot
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis bootdev pxe
```

Then reboot:

```bash
ipmitool -I lanplus -H 192.168.1.224 -U admin -E chassis power reset
```

## SOL (serial-over-LAN)

```bash
# Open SOL (some setups require an explicit instance)
ipmitool -I lanplus -H 192.168.1.224 -U admin -E sol activate instance=3
```

Exit SOL with the escape sequence `~.` (tilde then dot) on a new line.
Type `~?` inside SOL to see the available escape sequences.

## Sensors and event log (CPU + memory hints)

```bash
# Full sensor dump (filter down to what you care about)
ipmitool -I lanplus -H 192.168.1.224 -U admin -E sdr elist

# CPU and DIMM temperature sensors (if the BMC exposes them)
ipmitool -I lanplus -H 192.168.1.224 -U admin -E sdr elist | rg -i 'TEMP_CPU|PWR_CPU|DIMM_[A-H]1_TEMP'

# System event log (recent)
ipmitool -I lanplus -H 192.168.1.224 -U admin -E sel elist | tail -n 50
```

Notes:
- It is normal for DIMM temperature/presence sensors to show `No Reading` when the host
  is stuck early in memory training. In that state, SOL logs are more useful than SDR.
