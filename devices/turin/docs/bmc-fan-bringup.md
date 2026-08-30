# Turin BMC and fan bring-up

This runbook records the BMC identity, fan topology, and safe fan-control path
for the Turin H14SSL-NT tower.

## Identity

- BMC IP: `100.100.244.170`
- Current Talos API / Kubernetes node IP: `100.100.244.190`
- Historical bring-up / maintenance IP: `100.100.244.171`; do not assume it is the current Talos endpoint
- BMC MAC: `7c:c2:55:f1:69:a6`
- Board: Supermicro `H14SSL-NT`
- Cooler: SilverStone `XE360-SP5`

Resolve current Talos endpoints from
[`docs/runbooks/galactic-kubernetes-access.md`](../../../docs/runbooks/galactic-kubernetes-access.md) before operating
the node.

## Credential Handling

For an explicitly authorized Turin BMC action, use the existing signed-in 1Password CLI session. Do not probe macOS
Keychain, repeat sign-in attempts after the session is already authenticated, print the password, persist it, or place it
on the command line. Keep shell tracing disabled.

```bash
set +x
TURIN_BMC_ITEM='<exact Turin BMC item name or ID>'
TURIN_BMC_USER="$(op item get "$TURIN_BMC_ITEM" --fields label=username)"

IPMI_PASSWORD="$(op item get "$TURIN_BMC_ITEM" --fields label=password --reveal)" \
  ipmitool -I lanplus -H 100.100.244.170 -U "$TURIN_BMC_USER" -E chassis power status

unset TURIN_BMC_ITEM TURIN_BMC_USER
```

If `op` returns an authentication error, stop and report that exact error. Do not loop over `op signin` or ask for the
credential in chat.

## Fan State

- BMC fan mode: `Optimal`.
- `FAN2` is the relevant low-RPM alarm source.
- `FAN2` lower-critical target: `300 RPM`; BMC stored value: `280 RPM`.
- `FAN2` live tach: approximately `2520 RPM`, `Status: ok`.
- `FAN4` live tach: approximately `3780 RPM`.
- Redfish/UI health can remain `Critical` after live IPMI tach returns OK. Clear
  SEL before considering a BMC reset.

## Cooling Topology

- Pump: SilverStone `XE360-SP5` pump tach on motherboard `FAN4`.
- Pump behavior: stable 12V/full speed. Do not slow it for noise control.
- Radiator fans: three 4-pin PWM fans on the SilverStone daisy-chain connected
  to motherboard `FAN2`.
- `FAN2` reads one tach signal, but the PWM duty applies to all three radiator
  fans.
- Use exactly one motherboard fan-header connection for the radiator daisy
  chain. Leave unused pass-through connectors unused/capped.
- Only one fan tach reports to the motherboard header. Multiple tach wires tied
  together can confuse BMC fan monitoring.

## Source Notes

- H14SSL-N/NT fan headers `FAN1`-`FAN4`, `FANA`, and `FANB` are 4-pin headers
  controlled by BMC Thermal Management.
- SilverStone `XE360-SP5` pump spec: `3 pin`, `12V`, `0.38A`,
  `4000 +/- 10% RPM`.
- SilverStone `XE360-SP5` radiator fan spec: `4 pin PWM`, `600-2800 RPM`.
- SilverStone documentation calls for stable 12V pump power and the included
  `3 in 1 Fan cable` for the radiator fans.
- The cooler does not include a SilverStone software fan controller or quiet-mode
  module. The radiator fans follow a single motherboard/controller PWM input.

## BMC Findings

- Supported BMC/SMCIPMITool fan modes: `Standard`, `FullSpeed`, `Optimal`, and
  `HeavyIO`.
- `Liquid Cooling` and `Smart Speed` are general IPMICFG mode names, but this
  BMC rejects those mode IDs.
- Raw Supermicro zone-duty writes were not effective on this BMC. Zone 0 stayed
  at `0x64`/100% after lower-duty writes under both `Optimal` and `FullSpeed`.
- Clearing SEL removed prior log entries but did not lower `FAN2` RPM.
- Moving the radiator daisy-chain to another motherboard header does not solve
  the noise if that header is also commanded to 100% duty.
- Installing an OS does not bypass BMC Thermal Management. Talos can call IPMI or
  Redfish, but it reaches the same BMC controls already tested.

## Hardware Fan-Control Path

Keep the pump on stable 12V and control only the radiator fans.

Preferred manual controller: `Noctua NA-FC1`.

- It can manually generate/reduce PWM duty for up to three 4-pin PWM fans.
- It includes SATA power and a 3-way splitter.
- Its `no stop` mode keeps fans above roughly `300 RPM`, which helps avoid
  BIOS/BMC low-RPM fan alarms.
- Use the SATA-powered path so radiator fan current does not load the H14SSL-NT
  fan header.

Recommended wiring:

```text
PSU SATA power -> NA-FC1 SATA power adapter
H14SSL-NT FAN2 -> NA-FC1 input
NA-FC1 output -> three radiator fans
```

Startup procedure:

1. Set the controller to 100%.
2. Boot and verify `FAN2`, `FAN4`, CPU, memory, and system temperature sensors.
3. Reduce the dial gradually.
4. Keep `FAN2` comfortably above the lower-critical threshold.
5. Validate with the case closed and the final airflow path installed.

Other controller options:

- `Aqua Computer QUADRO`: better for autonomous saved curves with a temperature
  probe, but it requires USB/Aquasuite setup.
- `Phanteks PH-PWHUB_02 Universal Fan Controller`: usable only when a physical
  three-step remote is preferred and the controller is available.

Avoid plain PWM hubs as the noise fix. `SilverStone CPF04`, `Noctua NA-FH1`, and
the case `Nexus+ 2` are powered splitters; they repeat the motherboard PWM
signal. If the H14SSL-NT/BMC sends 100%, those hubs still run the radiator fans
hard.

The Fractal Design Define 7 XL rear `Nexus+ 2` hub remains useful only as a
powered distribution hub. It is not an independent fan controller.

## Pump Noise

If the pump is the audible source, troubleshoot mechanical causes instead of BMC
fan curves:

- pump/radiator vibration against the case
- trapped air or gurgling
- cable contact with fan blades
- radiator mounting pressure

A pump that remains too loud at its specified speed is a cooler/noise issue, not
a BMC fan-curve issue.

## Read-Only IPMI Checks

```bash
set +x
TURIN_BMC_ITEM='<exact Turin BMC item name or ID>'
TURIN_BMC_USER="$(op item get "$TURIN_BMC_ITEM" --fields label=username)"

turin_ipmi() {
  IPMI_PASSWORD="$(op item get "$TURIN_BMC_ITEM" --fields label=password --reveal)" \
    ipmitool -I lanplus -H 100.100.244.170 -U "$TURIN_BMC_USER" -E "$@"
}

turin_ipmi chassis power status
turin_ipmi sensor get FAN2
turin_ipmi sensor get FAN4
turin_ipmi sensor | rg -i 'fan|temp'
turin_ipmi sel elist | tail -n 50

unset -f turin_ipmi
unset TURIN_BMC_ITEM TURIN_BMC_USER
```

## Power Recovery

Prefer a normal Talos reboot while the Talos API and storage stack are responsive. Use BMC power control only after the
specific action is authorized and the exact node, etcd, Ceph, and workload gates have been checked.

For the three-node `galactic` control plane:

1. Verify all etcd members and identify the leader.
2. Cordon `turin`.
3. If Turin is the etcd leader, run `talosctl --nodes 100.100.244.190 etcd forfeit-leadership` and verify the new leader.
4. Verify that the other Ceph storage host is available and no second control-plane/storage node is in maintenance.
5. Issue exactly the authorized action.

```bash
set +x
TURIN_BMC_ITEM='<exact Turin BMC item name or ID>'
TURIN_BMC_USER="$(op item get "$TURIN_BMC_ITEM" --fields label=username)"

IPMI_PASSWORD="$(op item get "$TURIN_BMC_ITEM" --fields label=password --reveal)" \
  ipmitool -I lanplus -H 100.100.244.170 -U "$TURIN_BMC_USER" -E chassis power cycle

unset TURIN_BMC_ITEM TURIN_BMC_USER
```

After the node returns, verify the four expected NVMe devices by model, serial, and size; Kubernetes readiness and
pressure; etcd membership; all six Ceph OSDs; PG recovery; and workload scheduling before uncordoning. The complete
sequence is in
[`docs/runbooks/galactic-storage-and-workload-recovery.md`](../../../docs/runbooks/galactic-storage-and-workload-recovery.md).

## Redfish Fan Checks

Use `curl --config -` so the password is read from standard input instead of appearing in the process arguments:

```bash
set +x
TURIN_BMC_ITEM='<exact Turin BMC item name or ID>'
TURIN_BMC_USER="$(op item get "$TURIN_BMC_ITEM" --fields label=username)"

turin_redfish_get() {
  printf 'user = "%s:%s"\nurl = "%s"\ninsecure\nsilent\nshow-error\n' \
    "$TURIN_BMC_USER" \
    "$(op item get "$TURIN_BMC_ITEM" --fields label=password --reveal)" \
    "$1" |
    curl --config -
}

turin_redfish_get \
  'https://100.100.244.170/redfish/v1/Managers/1/Oem/Supermicro/FanMode' | jq .

turin_redfish_get \
  'https://100.100.244.170/redfish/v1/Chassis/1/ThermalSubsystem' | jq '.FansFullSpeedOverrideEnable'

unset -f turin_redfish_get
unset TURIN_BMC_ITEM TURIN_BMC_USER
```

Disable full-speed override if it is enabled. Observed H14SSL-NT Redfish state:
the property was absent/null in `ThermalSubsystem`, not `true`, and subsystem
status was OK.

```bash
set +x
TURIN_BMC_ITEM='<exact Turin BMC item name or ID>'
TURIN_BMC_USER="$(op item get "$TURIN_BMC_ITEM" --fields label=username)"

printf 'user = "%s:%s"\nurl = "%s"\ninsecure\nsilent\nshow-error\nrequest = "PATCH"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
  "$TURIN_BMC_USER" \
  "$(op item get "$TURIN_BMC_ITEM" --fields label=password --reveal)" \
  'https://100.100.244.170/redfish/v1/Chassis/1/ThermalSubsystem' \
  '{\"FansFullSpeedOverrideEnable\":false}' |
  curl --config -

unset TURIN_BMC_ITEM TURIN_BMC_USER
```

## SEL Cleanup

Clear SEL only after live sensor state is OK:

```bash
set +x
TURIN_BMC_ITEM='<exact Turin BMC item name or ID>'
TURIN_BMC_USER="$(op item get "$TURIN_BMC_ITEM" --fields label=username)"

IPMI_PASSWORD="$(op item get "$TURIN_BMC_ITEM" --fields label=password --reveal)" \
  ipmitool -I lanplus -H 100.100.244.170 -U "$TURIN_BMC_USER" -E sel clear
IPMI_PASSWORD="$(op item get "$TURIN_BMC_ITEM" --fields label=password --reveal)" \
  ipmitool -I lanplus -H 100.100.244.170 -U "$TURIN_BMC_USER" -E sel elist

unset TURIN_BMC_ITEM TURIN_BMC_USER
```

## SMCIPMITool Readback

Do not pass the real password to SMCIPMITool on the command line. Use `ipmitool -E` for live operations. The following
SMCIPMITool output is retained only as historical capability evidence:

```text
Current Fan Speed Mode is [ Optimal Speed ]

Supported Fan modes:
0: Standard Speed
1: Full Speed
2: Optimal Speed
4: Heavy IO Speed
```

Do not store the actual BMC password in this repo or in notes.
