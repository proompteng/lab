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

## Credential handling

For authorized BMC operations, use the existing operator-provisioned local file
`~/.config/lab-secrets/turin-bmc.json`. It contains `host`, `username`, and
`password`. Keep the file at mode `0600` and its directory at mode `0700`.
Load the stored username, including its casing. Keep passwords out of process
arguments, output, and Git. This procedure reads that existing source; it does
not create or copy credentials. Define this helper once for the commands below:

```bash
set +x
turin_ipmi() {
  python3 - "$@" <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path

credentials = json.loads((Path.home() / '.config/lab-secrets/turin-bmc.json').read_text())
if credentials['host'] != '100.100.244.170':
    raise SystemExit('Credential target does not match Turin BMC')
env = os.environ.copy()
env['IPMI_PASSWORD'] = credentials['password']
subprocess.run([
    'ipmitool', '-I', 'lanplus', '-H', credentials['host'],
    '-U', credentials['username'], '-E', '-N', '2', '-R', '1',
    *sys.argv[1:],
], env=env, check=True, timeout=20)
PY
}
```

Stop on authentication failure. Do not change the credential identity or target.

## Fan state

Verified on 2026-10-11 with Supermicro BMC firmware `1.01`:

- The automatic fan mode is `Optimal` after the tests below.
- `FAN2` reports a lower-critical threshold of `280 RPM`.
- `FAN4`, the recorded pump connection, stays at `3780 RPM` during both PWM tests.
- Redfish health and the SEL can retain an earlier alarm. Inspect live fan status
  before considering a separately authorized SEL clear or BMC reset.

## Cooling Topology

The operator identified four case fans, one CPU-cooler fan, and one pump
on 2026-10-12:

| Headers     | Connection     | PWM control group |
| ----------- | -------------- | ----------------- |
| `FAN1,FAN3` | Two case fans  | 0                 |
| `FAN2`      | CPU-cooler fan | 0                 |
| `FANA,FANB` | Two case fans  | 1                 |
| `FAN4`      | Pump           | Stable 12V        |

- Pump: SilverStone `XE360-SP5` pump tach on motherboard `FAN4`.
- Pump behavior: stable 12V/full speed. Do not slow it for noise control.
- The BMC exposes shared duty control for groups 0 and 1. Different fan
  models in the same group can run at different RPM at the same duty.
- Case-fan front/rear positions remain unverified.

## Source Notes

- H14SSL-N/NT fan headers `FAN1`-`FAN4`, `FANA`, and `FANB` are 4-pin headers
  controlled by BMC Thermal Management.
- SilverStone `XE360-SP5` pump spec: `3 pin`, `12V`, `0.38A`,
  `4000 +/- 10% RPM`.
- SilverStone `XE360-SP5` radiator fan spec: `4 pin PWM`, `600-2800 RPM`.
- SilverStone documentation calls for stable 12V pump power.
- The cooler does not include a SilverStone software fan controller or quiet-mode
  module. The CPU-cooler fan follows its motherboard/controller PWM input.

## Verified BMC controls

- Supported BMC/SMCIPMITool fan modes: `Standard`, `FullSpeed`, `Optimal`, and
  `HeavyIO`.
- `Liquid Cooling` and `Smart Speed` are general IPMICFG mode names, but this
  BMC rejects those mode IDs.
- A brief `Standard` test increased `FAN2` from `1540` to `2520 RPM`; it did not
  make the machine quieter. The test restored `Optimal`.
- Manual PWM control works after enabling the ATEN global bypass below. Older
  tests without that bypass do not establish that manual control is unavailable.
- This board rejected the OpenBMC per-zone flag read
  `raw 0x2e 0x04 0xcf 0xc2 0x00 0x00 0x01` with `0xc7`.

### Manual PWM and the restore path

The [SMFC H14 ATEN command reference](https://github.com/petersulyok/smfc/blob/199db316d015e1717db256ba253067a9be454ab9/doc/X14H14_MANUAL_FANCONTROL.md#part-4--aten-boards)
describes the interface verified here. The bypass suspends automatic thermal
control for **both** groups, including a group whose duty you leave unchanged.
The base mode still reads `Optimal` while bypass is active. Reading that mode
does not prove that automatic control is running.

Use manual duty only for an authorized, supervised test or with a controller
that reads temperatures, handles failed reads, and restores automatic control
on exit. A fixed duty has no temperature feedback. Do not disable System
Lockdown to make a rejected command succeed.

The following are command references, not an unattended controller:

```bash
turin_ipmi raw 0x30 0x45 0x00                 # base mode; 02 means Optimal
turin_ipmi raw 0x30 0x70 0x66 0x00 0x00       # group 0 duty
turin_ipmi raw 0x30 0x70 0x66 0x00 0x01       # group 1 duty
turin_ipmi sensor get FAN2
```

Before a speed test, read all fan statuses, CPU and DIMM temperatures, and the
[NIC's own sensor](../../galactic/network/README.md#read-nic-temperature).
Confirm that no other fan controller is running. This example requires the
original automatic mode to be `Optimal`. Prepare the restore commands before
enabling bypass. The verified tests used at least eight seconds of settling
time and restored automatic control on exit:

```bash
(
  set -e
  test "$(turin_ipmi raw 0x30 0x45 0x00 | tr -d '[:space:]')" = 02
  restore_automatic() {
    local released=1
    local restore_attempt
    for restore_attempt in 1 2 3; do
      if turin_ipmi raw 0x30 0x70 0x66 0x02 0x00; then
        released=0
        break
      fi
    done
    if turin_ipmi raw 0x30 0x45 0x01 0x02 && test "$released" -eq 0; then
      return 0
    fi
    turin_ipmi raw 0x30 0x70 0x66 0x01 0x00 0x64 || true
    turin_ipmi raw 0x30 0x70 0x66 0x01 0x01 0x64 || true
    printf '%s\n' 'Automatic recovery failed; check the BMC and release bypass.' >&2
    return 1
  }
  trap 'restore_automatic || exit 1' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  turin_ipmi raw 0x30 0x70 0x66 0x02 0x01
  turin_ipmi raw 0x30 0x70 0x66 0x01 0x00 0x37
  sleep 8
  turin_ipmi sdr list
)
```

Cleanup retries bypass release three times and attempts the mode refresh even
if release fails. If either recovery step fails, it attempts `100%` duty for
both groups independently and exits nonzero. That emergency fallback is not a
quiet operating setting or proof of restored automatic control. If the BMC
remains unreachable, those writes can also fail; the operator must recover it.

This example requests `55%` for group 0. The separate group 1 test used
`raw 0x30 0x70 0x66 0x01 0x01 0x55`, which requests `85%`.
Duty bytes are hexadecimal percentages, not RPM. The hardware returned `54%`
and `84%`, respectively, after rounding.

To restore control explicitly, release bypass **and** refresh the original
automatic mode, then verify duty and RPM after settling:

```bash
turin_ipmi raw 0x30 0x70 0x66 0x02 0x00
turin_ipmi raw 0x30 0x45 0x01 0x02
sleep 6
turin_ipmi sdr list
turin_ipmi raw 0x30 0x70 0x66 0x00 0x00
turin_ipmi raw 0x30 0x70 0x66 0x00 0x01
```

A release-only test still showed the reduced duty after three seconds.
Refreshing `Optimal` restored the observed automatic duties, `63%` and `100%`.
If restoration fails, do not report automatic control as restored.

### Measured fan groups

These are separate brief tests on 2026-10-11, not steady-load thermal acceptance:

| Header | Automatic RPM | Group 0 requested 55% | Group 1 requested 85% |
| ------ | ------------: | --------------------: | --------------------: |
| `FAN1` |          1260 |                  1120 |                  1260 |
| `FAN2` |          1540 |                  1260 |                  1540 |
| `FAN3` |          1120 |                   980 |                  1120 |
| `FAN4` |          3780 |                  3780 |                  3780 |
| `FANA` |          1680 |                  1680 |                  1400 |
| `FANB` |          1680 |                  1680 |                  1400 |

`FAN1`, `FAN2`, and `FAN3` respond together. `FANA` and `FANB` form the second
group. The three-pin pump's unchanged RPM does not establish a separate PWM
group. The CPU-cooler and pump roles above come from the recorded wiring;
front/rear case-fan positions and Noctua-to-header assignments remain unverified.
The BMC reports header names and RPM, not cable routing or fan model numbers.

The 2026-10-11 readback at 16:49 PDT was `Optimal`, with automatic duties of `63%`
and `100%`, CPU `43 C`, NIC `93 C`, and all fan sensors OK. No fixed manual
setting or continuous fan controller was left running.

### Operator-requested manual case-fan setting

On 2026-10-12, the operator selected approximately 1,250 RPM for the case-fan
headers. With manual bypass already active, the tested duties were 70% for
group 0 and 72% for group 1:

```bash
turin_ipmi raw 0x30 0x70 0x66 0x01 0x00 0x47
turin_ipmi raw 0x30 0x70 0x66 0x01 0x01 0x49
turin_ipmi raw 0x30 0x70 0x66 0x00 0x00
turin_ipmi raw 0x30 0x70 0x66 0x00 0x01
turin_ipmi sensor get FAN1 FAN2 FAN3 FAN4 FANA FANB
```

The request bytes `0x47,0x49` are 71% and 73%; readback `0x46,0x48` is 70%
and 72% after rounding. `FAN1,FAN3,FANA,FANB` reported 1,260 RPM, the closest
reported step to the target. The CPU-cooler fan's shared group put `FAN2` at
1,680 RPM; the `FAN4` pump stayed at 3,780 RPM. The CPU-cooler fan cannot receive
an independent duty while it shares group 0 with `FAN1,FAN3`.
The operator accepted that CPU-cooler speed while retaining the case-fan target.
These commands assume the existing manual bypass; they do not establish a
temperature-controlled fan policy.

Read both DIMM groups and the add-in NIC after a fan change:

```bash
turin_ipmi sensor get 'DIMMA~F Temp' 'DIMMG~L Temp' 'AOC_NIC1 Temp'
turin_ipmi sel elist last 10
```

Compare the actual reading and threshold even when IPMI labels the sensor
`ok`. An asserted upper-critical event or a reading above its threshold
requires more cooling; the requested RPM alone is not thermal acceptance.

## Hardware Fan-Control Path

Keep the pump on stable 12V and control only the CPU-cooler fan.

For physical PWM adjustment, `Noctua NA-FC1` is an alternative to software control.

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
NA-FC1 output -> CPU-cooler fan
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
signal. If the H14SSL-NT/BMC sends 100%, those hubs still run the CPU-cooler fan
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
turin_ipmi chassis power status
turin_ipmi sensor get FAN2
turin_ipmi sensor get FAN4
turin_ipmi sensor | rg -i 'fan|temp'
turin_ipmi sel elist | tail -n 50
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
turin_ipmi chassis power cycle
```

After the node returns, verify the four expected NVMe devices by model, serial, and size; Kubernetes readiness and
pressure; etcd membership; all six Ceph OSDs; PG recovery; and workload scheduling before uncordoning. The complete
sequence is in
[`docs/runbooks/galactic-storage-and-workload-recovery.md`](../../../docs/runbooks/galactic-storage-and-workload-recovery.md).

## Redfish Fan Checks

Load the same protected credential file in Python so HTTP authentication stays
out of process arguments. These requests read settings; they do not change them:

```bash
python3 - <<'PY'
import base64
import json
import ssl
import urllib.request
from pathlib import Path

credentials = json.loads((Path.home() / '.config/lab-secrets/turin-bmc.json').read_text())
if credentials['host'] != '100.100.244.170':
    raise SystemExit('Credential target does not match Turin BMC')
auth = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()
for path in (
    '/redfish/v1/Managers/1/Oem/Supermicro/FanMode',
    '/redfish/v1/Chassis/1/ThermalSubsystem',
):
    request = urllib.request.Request('https://' + credentials['host'] + path,
                                     headers={'Authorization': 'Basic ' + auth})
    with urllib.request.urlopen(request, context=ssl._create_unverified_context(), timeout=8) as response:
        print(json.dumps(json.load(response), indent=2))
PY
```

The trusted management endpoint uses its existing self-signed certificate.
The observed `FanMode` values are `Standard`, `FullSpeed`, `Optimal`, and
`HeavyIO`. `FansFullSpeedOverrideEnable` was absent from `ThermalSubsystem`;
do not PATCH a property that this resource does not expose.

## SEL Cleanup

Clear SEL only after live sensor state is OK:

```bash
turin_ipmi sel clear
turin_ipmi sel elist
```
