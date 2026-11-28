#!/usr/bin/env python3
"""Check the fixed PodCIDRs and live forwarding paths without changing the cluster."""

import argparse
import ipaddress
import json
import subprocess
import sys


NODES = {
    "talos-192-168-1-85": ("10.244.4.0/23", "100.100.244.142", "enP5p1s0"),
    "turin": ("10.244.0.0/23", "100.100.244.190", "eno2np1"),
    "talos-192-168-1-194": ("10.244.3.0/24", "100.100.244.141", "eno1"),
}
STORAGE = {"talos-192-168-1-85": "10.100.0.11", "turin": "10.100.0.12"}
KUBECTL = ["kubectl", "--context", "galactic-lan", "-n", "kube-system"]


def query(args):
    result = subprocess.run(
        KUBECTL + args, capture_output=True, text=True, timeout=30, check=True
    )
    return json.loads(result.stdout)


def validate_nodes(nodes):
    failures = []
    if {node["metadata"]["name"] for node in nodes} != set(NODES):
        failures.append("node membership differs from the reviewed three-node topology")
    for node in nodes:
        name = node["metadata"]["name"]
        if name not in NODES:
            continue
        cidr, address, _ = NODES[name]
        if node["spec"].get("podCIDRs") != [cidr]:
            failures.append(
                f"{name}: PodCIDR changed; review static routes before sync"
            )
        if not any(
            item["type"] == "InternalIP" and item["address"] == address
            for item in node["status"].get("addresses", [])
        ):
            failures.append(f"{name}: InternalIP differs from {address}")
        if not any(
            item["type"] == "Ready" and item["status"] == "True"
            for item in node["status"].get("conditions", [])
        ):
            failures.append(f"{name}: node is not Ready")
    return failures


def pod_addresses(node):
    network = ipaddress.ip_network(NODES[node][0])
    blocks = network.subnets(new_prefix=24) if network.prefixlen < 24 else [network]
    return [str(block.network_address + 10) for block in blocks]


def validate_storage_links(node, links):
    failures = []
    bonds = [link for link in links if link["ifname"] == "storage0"]
    if len(bonds) != 1 or not any(
        address.get("local") == STORAGE[node] and address.get("prefixlen") == 24
        for link in bonds
        for address in link.get("addr_info", [])
    ):
        failures.append(f"{node}: storage0 does not own its reviewed storage address")
    members = [link for link in links if link.get("master") == "storage0"]
    if not members:
        failures.append(f"{node}: storage0 has no member interface")
    for member in members:
        if any(a.get("family") == "inet" for a in member.get("addr_info", [])):
            failures.append(
                f"{node}: storage0 member {member['ifname']} retains an IPv4 address"
            )
    return failures


def route_cases(node):
    _, host, lan = NODES[node]
    for peer, (_, peer_host, _) in NODES.items():
        if peer == node:
            continue
        direct = node in STORAGE and peer in STORAGE
        device = "storage0" if direct else "flannel.1"
        gateway = (
            STORAGE[peer]
            if direct
            else str(ipaddress.ip_network(NODES[peer][0]).network_address)
        )
        if direct:
            storage_peer = STORAGE[peer]
            yield f"host source to {storage_peer}", [storage_peer], "storage0", None
            yield (
                f"host to {storage_peer}",
                [storage_peer, "from", host],
                "storage0",
                None,
            )
            for source in pod_addresses(node):
                yield (
                    f"{source} to {storage_peer}",
                    [storage_peer, "from", source, "iif", "cni0"],
                    "storage0",
                    None,
                )
        for target in pod_addresses(peer):
            yield f"host source to {target}", [target], device, gateway
            yield f"host to {target}", [target, "from", host], device, gateway
            for source in pod_addresses(node):
                yield (
                    f"{source} to {target}",
                    [target, "from", source, "iif", "cni0"],
                    device,
                    gateway,
                )
        for source in pod_addresses(node):
            yield (
                f"{source} to {peer} host",
                [peer_host, "from", source, "iif", "cni0"],
                "storage0" if direct else lan,
                STORAGE[peer] if direct else None,
            )
        yield f"host to {peer} host", [peer_host, "from", host], lan, None


def route_matches(node, route, device, gateway, result):
    expected_source = (
        STORAGE[node]
        if route[0] in STORAGE.values()
        else str(ipaddress.ip_network(NODES[node][0]).network_address)
    )
    return (
        result.get("dev") == device
        and result.get("gateway") == gateway
        and (len(route) != 1 or result.get("prefsrc") == expected_source)
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--preflight", action="store_true", help="check topology before applying routes"
    )
    args = parser.parse_args()
    failures = validate_nodes(query(["get", "nodes", "-o", "json"])["items"])
    observations = []
    if not failures and not args.preflight:
        pods = query(["get", "pods", "-l", "k8s-app=flannel,tier=node", "-o", "json"])[
            "items"
        ]
        for node in NODES:
            matches = [
                pod
                for pod in pods
                if pod["spec"].get("nodeName") == node
                and pod["status"].get("phase") == "Running"
                and not pod["metadata"].get("deletionTimestamp")
            ]
            if len(matches) != 1:
                raise ValueError(f"expected one running Flannel pod on {node}")
            pod = matches[0]["metadata"]["name"]
            if node in STORAGE:
                prefix = [
                    "exec",
                    pod,
                    "-c",
                    "kube-flannel",
                    "--",
                    "ip",
                    "-j",
                    "address",
                    "show",
                ]
                # Listing all links succeeds even when the required bond is absent.
                # A missing bond is a failed topology check, not unavailable evidence.
                failures.extend(validate_storage_links(node, query(prefix)))
                if failures:
                    break
            for label, route, device, gateway in route_cases(node):
                result = query(
                    [
                        "exec",
                        pod,
                        "-c",
                        "kube-flannel",
                        "--",
                        "ip",
                        "-j",
                        "route",
                        "get",
                        *route,
                    ]
                )[0]
                observations.append({"node": node, "path": label, "route": result})
                if not route_matches(node, route, device, gateway, result):
                    failures.append(
                        f"{node}: {label}: incorrect interface, gateway, or host source"
                    )
    print(json.dumps({"failures": failures, "routes": observations}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        subprocess.SubprocessError,
        ValueError,
        KeyError,
        IndexError,
        OSError,
    ) as error:
        print(f"UNKNOWN: {error}", file=sys.stderr)
        sys.exit(2)
