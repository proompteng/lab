#!/bin/sh

# Debian's /etc/profile replaces the container PATH for every login shell.
# Hermes captures that login environment for terminal sessions, so reassert
# the immutable production tool path after the system profile initializes.
export PATH='/opt/tools:/opt/lab-toolchain/bin:/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
