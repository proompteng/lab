#!/bin/sh
set -eu

umask 077

mkdir -p \
  /opt/data/cron \
  /opt/data/home \
  /opt/data/logs \
  /opt/data/memories \
  /opt/data/pairing \
  /opt/data/platforms/pairing \
  /opt/data/plans \
  /opt/data/sessions \
  /opt/data/skills \
  /opt/data/workspace/tuslagch

seed_file() {
  source_path=$1
  destination_path=$2
  if [ ! -e "$destination_path" ]; then
    install -m 0600 "$source_path" "$destination_path"
  fi
}

seed_file /opt/bootstrap/USER.md /opt/data/memories/USER.md

/opt/hermes/.venv/bin/hermes config check >/tmp/hermes-config-check.log
