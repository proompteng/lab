# Turin BMC and fan bring-up

This runbook records the BMC identity, fan topology, and safe fan-control path
for the Turin H14SSL-NT tower.

## Identity

- BMC IP: `100.100.244.170`
- BMC MAC: `7c:c2:55:f1:69:a6`
- Board: Supermicro `H14SSL-NT`
- Cooler: SilverStone `XE360-SP5`

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
export IPMI_PASSWORD='...'

ipmitool -I lanplus -H 100.100.244.170 -U ADMIN -E chassis power status
ipmitool -I lanplus -H 100.100.244.170 -U ADMIN -E sensor get FAN2
ipmitool -I lanplus -H 100.100.244.170 -U ADMIN -E sensor get FAN4
ipmitool -I lanplus -H 100.100.244.170 -U ADMIN -E sensor | rg -i 'fan|temp'
ipmitool -I lanplus -H 100.100.244.170 -U ADMIN -E sel elist | tail -n 50
```

## Redfish Fan Checks

```bash
export BMC_PASSWORD='...'

curl -sk -u "ADMIN:${BMC_PASSWORD}" \
  https://100.100.244.170/redfish/v1/Managers/1/Oem/Supermicro/FanMode | jq .

curl -sk -u "ADMIN:${BMC_PASSWORD}" \
  https://100.100.244.170/redfish/v1/Chassis/1/ThermalSubsystem | jq '.FansFullSpeedOverrideEnable'
```

Disable full-speed override if it is enabled. Observed H14SSL-NT Redfish state:
the property was absent/null in `ThermalSubsystem`, not `true`, and subsystem
status was OK.

```bash
export BMC_PASSWORD='...'

curl -sk -u "ADMIN:${BMC_PASSWORD}" -X PATCH -H 'Content-Type: application/json' \
  -d '{"FansFullSpeedOverrideEnable":false}' \
  https://100.100.244.170/redfish/v1/Chassis/1/ThermalSubsystem
```

## SEL Cleanup

Clear SEL only after live sensor state is OK:

```bash
export IPMI_PASSWORD='...'

ipmitool -I lanplus -H 100.100.244.170 -U ADMIN -E sel clear
ipmitool -I lanplus -H 100.100.244.170 -U ADMIN -E sel elist
```

## SMCIPMITool Readback

```bash
java -jar /path/to/SMCIPMITool.jar 100.100.244.170 ADMIN '...' ipmi fan
```

```text
Current Fan Speed Mode is [ Optimal Speed ]

Supported Fan modes:
0: Standard Speed
1: Full Speed
2: Optimal Speed
4: Heavy IO Speed
```

Do not store the actual BMC password in this repo or in notes.
