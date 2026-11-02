#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec </dev/null
printf 'Carrier fan controller, PWM device 0\n'
for channel in 0 1 3 4; do
  /usr/local/bin/pwmtachtool 0 --get-pwm-dutycycle "$channel"
  /usr/local/bin/pwmtachtool 0 --get-fan-speed "$channel"
done
test -r /proc/self/comm || { printf 'Process inspection is unavailable\n' >&2; exit 1; }
thermal_processes=0
for process in /proc/[0-9]*/comm; do
  test -r "$process" || continue
  IFS= read -r name < "$process" || continue
  if test "$name" = thermalmgr; then
    identifier=${process%/comm}
    printf 'thermalmgr PID %s\n' "${identifier##*/}"
    thermal_processes=$((thermal_processes + 1))
  fi
done
printf 'thermalmgr process count %s\n' "$thermal_processes"
for configuration in /conf/fanmap.ini /conf/zonemap.ini /conf/fscprofile.ini; do
  printf 'Configuration %s\n' "$configuration"
  cat "$configuration"
done
