#!/usr/bin/env python3
"""Read-only address and storage gates; workload continuity needs its own review."""

import argparse
import ipaddress
import json
import subprocess
from datetime import datetime, timezone


CLUSTER_CIDR = ipaddress.ip_network("10.244.0.0/16")
NODES = {"turin", "talos-192-168-1-85", "talos-192-168-1-194"}


def ready(obj):
    return any(
        condition["type"] == "Ready" and condition["status"] == "True"
        for condition in obj.get("status", {}).get("conditions", [])
    )


def evaluate(nodes, pods, ceph, target, migrated=False):
    failures = []
    warnings = []
    networks = {}
    addresses = {}
    if {node["metadata"]["name"] for node in nodes} != NODES:
        failures.append("node membership differs from the reviewed three-node cluster")
    for node in nodes:
        name = node["metadata"]["name"]
        spec = node["spec"]
        if not ready(node):
            failures.append(f"{name}: node is not Ready")
        if name != target and spec.get("unschedulable"):
            failures.append(f"{name}: another node is cordoned")
        if name != target and any(
            taint.get("effect") in ("NoSchedule", "NoExecute")
            for taint in spec.get("taints", [])
        ):
            failures.append(f"{name}: another node has a scheduling or eviction taint")
        if any(
            condition["type"].endswith("Pressure") and condition["status"] != "False"
            for condition in node["status"].get("conditions", [])
        ):
            failures.append(f"{name}: node pressure is not clear")
        cidrs = spec.get("podCIDRs", [])
        if len(cidrs) != 1 or cidrs[0] != spec.get("podCIDR"):
            failures.append(f"{name}: expected one consistent IPv4 PodCIDR")
            continue
        network = ipaddress.ip_network(cidrs[0])
        if network.version != 4 or not network.subnet_of(CLUSTER_CIDR):
            failures.append(f"{name}: PodCIDR is outside {CLUSTER_CIDR}")
            continue
        if network.prefixlen not in (23, 24):
            failures.append(f"{name}: unexpected prefix /{network.prefixlen}")
            continue
        networks[name] = network
        limit = int(node["status"]["capacity"]["pods"])
        addresses[name] = {"podCIDR": str(network), "maxPods": limit, "podIPs": 0}
        if limit > network.num_addresses - 3:
            warnings.append(f"{name}: maxPods {limit} exceeds CNI address capacity")
        if name == target:
            expected_limit = 500 if migrated else 250
            if limit != expected_limit:
                failures.append(
                    f"{name}: expected maxPods {expected_limit}, found {limit}"
                )
            if migrated and network.prefixlen != 23:
                failures.append(f"{name}: migrated node must have a /23 PodCIDR")
    if target not in networks:
        failures.append(f"{target}: target has no verified PodCIDR")
    for name, network in networks.items():
        for other, other_network in networks.items():
            if name >= other:
                continue
            parent = (
                network.supernet(new_prefix=23) if network.prefixlen == 24 else network
            )
            other_parent = (
                other_network.supernet(new_prefix=23)
                if other_network.prefixlen == 24
                else other_network
            )
            if network.overlaps(other_network) or parent.overlaps(other_parent):
                failures.append(
                    f"{name}, {other}: overlap within one allocator /23 block"
                )

    seen = {}
    mds_hosts = {}
    for pod in pods:
        metadata, spec = pod["metadata"], pod["spec"]
        name = f"{metadata['namespace']}/{metadata['name']}"
        if pod["status"]["phase"] in ("Succeeded", "Failed"):
            continue
        host = spec.get("nodeName")
        labels = metadata.get("labels", {})
        if (
            metadata["namespace"] == "rook-ceph"
            and labels.get("app") == "rook-ceph-mds"
            and labels.get("rook_file_system") == "cephfs"
            and ready(pod)
            and not metadata.get("deletionTimestamp")
            and host in networks
        ):
            mds_hosts[labels["ceph_daemon_id"]] = host
        if spec.get("hostNetwork"):
            continue
        for pod_ip in pod["status"].get("podIPs", []):
            address = ipaddress.ip_address(pod_ip["ip"])
            if address.version != 4:
                continue
            if host not in networks or address not in networks[host]:
                failures.append(f"{name}: IP {address} is outside its node PodCIDR")
            elif address in seen:
                failures.append(f"{name}, {seen[address]}: duplicate pod IP {address}")
            else:
                seen[address] = name
                addresses[host]["podIPs"] += 1

    if ceph.get("health", {}).get("status") != "HEALTH_OK" or ceph.get(
        "health", {}
    ).get("mutes"):
        failures.append("Ceph must be HEALTH_OK with no muted health checks")
    if len(ceph.get("quorum_names", [])) != 3:
        failures.append("Ceph monitor quorum must contain all three monitors")
    osds = ceph.get("osdmap", {})
    if any(osds.get(key) != 6 for key in ("num_osds", "num_up_osds", "num_in_osds")):
        failures.append("all six OSDs must be up and in")
    if osds.get("num_remapped_pgs") != 0:
        failures.append("Ceph has remapped PGs or missing recovery evidence")
    pgmap = ceph.get("pgmap", {})
    groups = pgmap.get("pgs_by_state", [])
    if not groups or sum(group["count"] for group in groups) != pgmap.get("num_pgs"):
        failures.append("Ceph PG accounting is incomplete")
    for group in groups:
        states = set(group["state_name"].split("+"))
        if not {"active", "clean"}.issubset(states) or states - {
            "active",
            "clean",
            "scrubbing",
            "deep",
        }:
            failures.append(f"Ceph PGs are not fully recovered: {group['state_name']}")
    daemons = ceph.get("fsmap", {}).get("by_rank", [])
    active = [daemon for daemon in daemons if daemon["status"] == "up:active"]
    standby = [daemon for daemon in daemons if daemon["status"] == "up:standby-replay"]
    if len(active) != 1 or len(standby) != 1:
        failures.append("CephFS must have one active MDS and one standby-replay MDS")
    hosts = {mds_hosts.get(daemon["name"]) for daemon in active + standby}
    if None in hosts or len(hosts) != 2:
        failures.append("active and standby CephFS MDS must be Ready on separate hosts")
    return {
        "failures": failures,
        "warnings": warnings,
        "nodes": addresses,
        "mdsHosts": mds_hosts,
    }


def kubectl(namespace, *args):
    result = subprocess.run(
        [
            "kubectl",
            "--context",
            "galactic-lan",
            "--request-timeout=30s",
            "-n",
            namespace,
            *args,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--node", required=True, choices=["turin", "talos-192-168-1-85"]
    )
    parser.add_argument(
        "--migrated", action="store_true", help="require /23 and maxPods 500"
    )
    args = parser.parse_args()
    try:
        nodes = kubectl("default", "get", "nodes", "-o", "json")["items"]
        pods = kubectl("default", "get", "pods", "-A", "-o", "json")["items"]
        ceph = kubectl(
            "rook-ceph",
            "exec",
            "deploy/rook-ceph-tools",
            "--",
            "ceph",
            "status",
            "--format",
            "json",
        )
        report = evaluate(nodes, pods, ceph, args.node, args.migrated)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f"preflight could not establish live evidence: {error}\n")
    report["observedAt"] = datetime.now(timezone.utc).isoformat()
    report["scope"] = (
        "address and storage gates only; not workload continuity or migration authorization"
    )
    print(json.dumps(report, indent=2))
    raise SystemExit(1 if report["failures"] else 0)


if __name__ == "__main__":
    main()
