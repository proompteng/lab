# Altra BMC and IPMI

Use this runbook to access Altra's BMC, read temperatures, control carrier fan
PWM, and restore automatic cooling.

## Identity

- BMC/IPMI address: `192.168.0.100`
- BMC subnet: `192.168.0.0/24`
- IPMI user: `admin`
- Talos node name: `talos-192-168-1-85`
- Legacy Talos LAN address: `192.168.1.85`
- Current Talos provider-LAN endpoint: `100.100.244.142`

Do not confuse the BMC address with the Talos node addresses. The BMC does not
answer on the `100.100.244.128/25` provider LAN; reach it
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

## Read CPU and RAM temperatures

Altra has a carrier BMC and a module management controller. The default sensor
list and Web UI show carrier sensors. Query the module over IPMB bus `0`, target
`0x82`, before concluding that CPU or RAM temperatures are unavailable.

With `IPMI_PASSWORD` set, read the module's sensor records and CPU temperature:

```bash
ipmitool -I lanplus -H 192.168.0.100 -U admin -E -m 0x20 -b 0 -t 0x82 sdr elist
ipmitool -I lanplus -H 192.168.0.100 -U admin -E -m 0x20 -b 0 -t 0x82 sensor get 'CPU Core Temp'
```

Standard module sensor reads work with `lanplus`. On this Mac, `ipmitool 1.8.19`
intermittently crashes during raw bridge reads, even with requester address
`-m 0x20`. The raw-register command below uses the tested `lan` interface.
`lan` uses IPMI 1.5 without session encryption. Run it only on the trusted BMC
management network. The command does not change BMC settings or retry with a
different protocol.

The module's sensor records do not include every RAM temperature. Read the
SMPro registers through the module with OEM command `0x30 0x31`, CPU I2C address
`0x9e`, and the register number. The following read-only command uses the
existing protected local credential file without putting its password in
arguments or output:

```bash
python3 - <<'PY'
import json
import os
from pathlib import Path
import subprocess

credentials = json.loads((Path.home() / '.config/lab-secrets/altra-bmc.json').read_text())
env = os.environ.copy()
env['IPMI_PASSWORD'] = credentials['password']
command = [
    'ipmitool', '-I', 'lan', '-H', credentials['host'],
    '-U', credentials['username'], '-E', '-N', '2', '-R', '1',
    '-m', '0x20', '-b', '0', '-t', '0x82', 'raw', '0x30', '0x31', '0x9e',
]
registers = [
    ('CPU', 0x10), ('SoC VRD', 0x11), ('DIMM VRD', 0x12), ('Core VRD', 0x13),
    *[(f'DIMM channel {channel}', 0x14 + channel) for channel in range(8)],
    ('RCA VRD', 0x1C), ('Memory hot threshold', 0x32), ('SoC VR hot threshold', 0x33),
]
for name, register in registers:
    result = subprocess.run(
        [*command, hex(register)], env=env, text=True,
        stdout=subprocess.PIPE, check=True, timeout=15,
    )
    raw = bytes.fromhex(result.stdout)
    if len(raw) != 2:
        raise ValueError(f'{name}: expected two bytes, received {len(raw)}')
    if raw == b'\xff\xff':
        print(f'{name}: unavailable')
        continue
    value = int.from_bytes(raw, 'little') & 0x1FF
    temperature = value - 0x200 if value & 0x100 else value
    print(f'{name}: {temperature} C')
PY
```

Keep `altra-bmc.json` outside the repository with file mode `0600` and its
parent directory mode `0700`. Its keys are `host`, `username`, and `password`.

Responses contain two bytes in little-endian order. `ff ff` means unavailable,
not `-1 C`. For other responses, decode the signed low nine bits as degrees
Celsius. For example, `31 00` is `49 C`. Compare RAM readings with the current
memory-hot threshold from register `0x32`. A temperature alone does not identify
which sensor controls a fan.

These registers cover CPU, RAM, and voltage regulators. They do not establish
the temperature of an add-in NIC. Record that temperature as unknown until it
is read from the NIC's telemetry.

Temperature references:

- [ADLINK's module bridge and CPU temperature command](https://www.ipi.wiki/community/forum/topic/119644/access-to-smpro-telemetry-from-the-bmc)
- [Linux SMPro register map and temperature decoding](https://github.com/torvalds/linux/blob/aaed66fadba2d2de8fe0daa0aa3eac827d2076b9/drivers/hwmon/smpro-hwmon.c)

## Fan headers and control

Readback on 2026-10-11 identified an ADLINK carrier BMC with firmware `2.07`,
manufacturer ID `24339`, and product ID `514`. Its web interface is MegaRAC
SP-X. Use this identity when selecting commands; Supermicro and ASRock fan
commands are not an interface for this carrier.

The [ADLINK carrier manual, pages 33–34](https://www.adlinktech.com/Products/Download.ashx?file=1956%5CCOM-HPC_Server-Base_manual_50M-77106-1000-10_230720.pdf&isManual=yes&type=MDownload)
identifies four BMC-controlled headers: `FAN_1`, `FAN_2`, `FAN_4`, and `FAN_5`.
There is no `FAN_3` header in that manual's fan table. The module-controlled
`FAN_0` is separate and has no carrier SDR reading. Trace the cable to the board
label before assigning a front, rear, radiator, or pump role.

### BMC shell control

Firmware `2.07` includes `/usr/local/bin/pwmtachtool`. A live trial on
2026-10-12 raised PWM channels `0` and `1` from 60% to 100%; the native
tachometer readings increased, and the original duties were restored.
The running `thermalmgr` also returned those channels to its automatic curve.

The BMC's SSH operating-system account is separate from its IPMI/Web UI
account. The local `altra-bmc.json` contains IPMI credentials, which do not
authenticate this SSH account. Keep SSH credentials outside this repository
and shell arguments. Verify the SSH host key before connecting to
`192.168.0.100`.

ADLINK's [carrier firmware download](https://www.ipi.wiki/pages/ampere-altra-developer-platform-download)
contains `COM_HPC_Server_Carrier_BMC_Engineer_Specification_R6.docx`, which
documents this SSH interface. The available `2.08` release changes NFS image
mounting; the tested fan procedure uses the installed `2.07` firmware.

Run these commands **inside the BMC SSH shell**, not on the Talos host:

```sh
tool=/usr/local/bin/pwmtachtool
for channel in 0 1 3 4; do
    "$tool" 0 --get-pwm-dutycycle "$channel"
    "$tool" 0 --get-fan-speed "$channel"
done
cat /conf/fanmap.ini /conf/zonemap.ini /conf/fscprofile.ini
ps | grep '[t]hermalmgr'
```

The first argument is PWM device `0`. The channel mapping is from the live
`/conf/fanmap.ini`, checked against the carrier's physical header labels:

| Carrier header | Carrier sensor | PWM/tach channel | Automatic baseline |
| -------------- | -------------- | ---------------: | ------------------ |
| `FAN_1`        | `BMC_FAN1`     |                0 | Zone 1             |
| `FAN_2`        | `BMC_FAN2`     |                1 | Zone 1             |
| `FAN_4`        | `BMC_FAN4`     |                3 | 100%               |
| `FAN_5`        | `BMC_FAN5`     |                4 | 100%               |

Zone 1 uses carrier sensor IDs `16,17` (rear/front temperatures), not the
bridged CPU, RAM, or NIC temperature. Its stock curve is 40% below 30 C, 50%
at 30–34 C, 60% at 35–39 C, 70% at 40–44 C, 80% at 45–49 C, 90% at 50–55 C,
and 100% from 56 C. A direct PWM write to channels `0` or `1` is temporary
while `thermalmgr` runs.

Native tachometer readings and carrier IPMI RPM readings disagree; several
IPMI readings are approximately twice the native readings. Record the source
of an RPM value and compare duty changes using the same interface. The native
fan-property table was uninitialized, so do not use `--set-fan-speed` as a
calibrated RPM controller or change its property table to conceal the mismatch.

### Set the installed Noctua case fans near 1,250 RPM

The operator identified four connected Noctua case fans on 2026-10-12:
three at the front and one at the rear, with no pump identified on these
headers. The header-to-position mapping is not established.

The earlier 1,200-RPM fixed profile let the hottest RAM channels reach
86–87 C against an 80 C memory-hot threshold. After a higher-airflow trial,
the operator selected 1,250 RPM. Check RAM temperatures under the current
load; matching the requested RPM does not establish adequate cooling.

The tested fixed duties are:

| Carrier header | PWM/tach channel | Duty | Native RPM samples |
| -------------- | ---------------: | ---: | -----------------: |
| `FAN_1`        |                0 |  55% |               1256 |
| `FAN_2`        |                1 |  33% |               1251 |
| `FAN_4`        |                3 |  67% |               1246 |
| `FAN_5`        |                4 |  67% |               1249 |

These are native-tool readings, not calibrated physical speeds. The BMC
carrier's IPMI RPM values use a different scale, as described above.

Apply the profile inside the BMC shell. On a command failure, the cleanup
attempts full duty on every channel and starts the stock manager if absent:

```sh
(
    set -e
    tool=/usr/local/bin/pwmtachtool
    restore_failed_trial() {
        result=$?
        trap - 0 HUP INT TERM
        for channel in 0 1 3 4; do
            "$tool" 0 --set-pwm-dutycycle "$channel" 100 || result=1
        done
        if ! ps | grep -q '[t]hermalmgr$'; then
            /etc/init.d/thermalmgr.sh start >/dev/null 2>&1 </dev/null || result=1
        fi
        exit "$result"
    }
    trap restore_failed_trial 0
    trap 'exit 1' HUP INT TERM
    /etc/init.d/thermalmgr.sh stop
    if ps | grep -q '[t]hermalmgr$'; then
        echo 'thermalmgr is still running' >&2
        exit 1
    fi
    "$tool" 0 --set-pwm-dutycycle 0 55
    "$tool" 0 --set-pwm-dutycycle 1 33
    "$tool" 0 --set-pwm-dutycycle 3 67
    "$tool" 0 --set-pwm-dutycycle 4 67
    sleep 5
    for channel in 0 1 3 4; do
        "$tool" 0 --get-pwm-dutycycle "$channel"
        "$tool" 0 --get-fan-speed "$channel"
    done
    trap - 0 HUP INT TERM
)
```

If a fan reports zero or its reading is unavailable, restore automatic cooling.
Read CPU, RAM, regulator, and [NIC temperatures](../../galactic/network/README.md#read-nic-temperature)
again after the fans settle.
The profile disables automatic temperature response and does not install a
startup override. Recheck and reapply after a BMC restart. A temperature check
at one workload does not establish cooling under a heavier workload.

### Change PWM duty

Confirm the pump's header before lowering any duty. Fixed PWM disables the
automatic temperature response on channels `0,1`. Read CPU, RAM, regulator,
and [NIC temperatures](../../galactic/network/README.md#read-nic-temperature)
before and after the adjustment.

Inside the BMC shell, stop the manager and verify that it stopped:

```sh
/etc/init.d/thermalmgr.sh stop
ps | grep '[t]hermalmgr$'
```

The second command must have no output. Set a confirmed channel's duty with
`/usr/local/bin/pwmtachtool 0 --set-pwm-dutycycle CHANNEL PERCENT`.
`PERCENT` accepts `1` through `100`. Read back duty and native RPM after each
change. A successful command alone does not establish fan speed or cooling.

### Restore automatic cooling

Set all four channels to full duty, then restart the stock manager:

```sh
(
    tool=/usr/local/bin/pwmtachtool
    result=0
    for channel in 0 1 3 4; do
        "$tool" 0 --set-pwm-dutycycle "$channel" 100 || result=1
    done
    /etc/init.d/thermalmgr.sh stop || result=1
    /etc/init.d/thermalmgr.sh start >/dev/null 2>&1 </dev/null || result=1
    ps | grep '[t]hermalmgr$' || result=1
    exit "$result"
)
```

The block restarts the manager even if a PWM write fails and returns nonzero
if any operation fails. Read back every channel after a failure; the manager
controls only channels `0,1`.

Verify that `thermalmgr` runs. Repeat the duty and RPM reads until channels
`0,1` follow the stock curve; channels `3,4` remain at 100%. During the tested
restore, carrier temperatures were 38 C and channels `0,1` returned to 60%.
The manager does not update duty immediately after startup.

Direct PWM writes do not edit `/conf/fscprofile.ini` or install a startup
override. Recheck the manager and duties after a BMC restart.

### IPMI interface limits

These IPMI reads still do not provide fan-speed control:

| Read                                      | Carrier BMC             | Module at IPMB `0x82`   |
| ----------------------------------------- | ----------------------- | ----------------------- |
| PICMG properties, `raw 0x2c 0x00 0x00`    | `0xc1`, invalid command | `00 14 00 00`           |
| Fan properties, `raw 0x2c 0x14 0x00 0x00` | `0xc1`, invalid command | `0xc1`, invalid command |
| Fan level, `raw 0x2c 0x16 0x00 0x00`      | `0xc1`, invalid command | `0xc1`, invalid command |

The module's PICMG identity response does not establish fan-control support.
The local `ipmitool picmg` command also failed its address-information check;
the raw reads above separate that client failure from the controller responses.

An HTTPS request to `/redfish/v1/` returned the web application's HTML rather
than a Redfish JSON service root. The served `/source.min.js` bundle contained
fan sensor and event handling, but no fan-speed control route was identified.
These observations establish the limits of the tested interfaces, not that
every OEM interface or future firmware lacks fan control. Do not guess raw
writes without a carrier-specific command definition and a verified restore path.

To repeat a module identity read with `IPMI_PASSWORD` set, use the trusted BMC
network and the tested `lan` transport described above:

```bash
ipmitool -I lan -H 192.168.0.100 -U admin -E -N 2 -R 1 \
  -m 0x20 -b 0 -t 0x82 raw 0x2c 0x00 0x00
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
