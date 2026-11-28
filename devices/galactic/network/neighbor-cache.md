# Verify neighbor-cache and DNS recovery

The cluster-wide `30-galactic-neighbor-cache` patch in the [Omni template](../omni/cluster-template.yaml) owns the
IPv4 neighbor limits. Its thresholds are 4,096, 8,192, and 16,384. Apply reviewed changes through the
[private render, validate, and sync workflow](../omni/README.md). Validate complete machine configurations and a
Talos `no-reboot` dry run first. The sync must change only the neighbor-cache patch.

On Turin, the previous 1,024-entry maximum produced active `arp_cache: neighbor table overflow!` events and
intermittent DNS failures. Increasing the thresholds addresses that observed capacity fault. Require both the
counter check and the application check below before declaring DNS recovered. Route or MTU changes are not needed.

## Check every host

Run from the repository root with Kubernetes access to `galactic-lan`:

```bash
python3 devices/galactic/network/verify-neighbor-cache.py --seconds 30
```

This read-only check discovers each host's existing Flannel pod. It verifies both samples have the expected limits,
the boot ID is unchanged, and no new `table_fulls` events occurred. The `entries` field is repeated in each CPU row;
the check takes the first value and sums only the per-CPU counters. Historical overflow totals do not reset on repair.
Exit `0` means those checks passed, `1` means a limit or overflow check failed, and `2` means evidence is unavailable
or reset. A short sample does not establish long-term stability or application recovery.

## Repeat the affected application lookup

Use the affected application's own recovery runbook to repeat DNS lookups from its running workload on Turin.
Preserve its configured search domains and A/AAAA behavior. Require repeated successful lookups under one second.

Also query both current CoreDNS pod endpoints and the DNS Service directly for A and AAAA records. Require the
affected application to complete its actual work. Successful DNS probes alone do not establish application recovery.
Check node readiness, Ceph monitor quorum and OSD availability, then repeat the Omni dry run and require zero changes.

To recover from an incorrect setting, revert only the neighbor-cache patch through the same reviewed Omni workflow.
Restoring 128/512/1024 while demand remains high can reproduce the outage. Do not flush the neighbor table as part
of this change. Remove private rendered machine configurations after use.
