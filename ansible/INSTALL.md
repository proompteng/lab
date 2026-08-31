# Installing Ansible

Status: Current for explicitly selected Ubuntu hosts. Ansible does not configure Talos nodes in the `galactic` cluster.

## Install

On macOS:

```bash
brew install ansible
```

On Ubuntu/Debian:

```bash
sudo apt update
sudo apt install ansible
```

Verify:

```bash
ansible --version
```

## Scope and preflight

The checked-in inventory still contains former K3s/Rancher hosts. Treat it as legacy until each target is verified. Before
running a retained Ubuntu-host playbook:

1. inspect `ansible/inventory/hosts.ini` and the playbook's host selector;
2. verify the target is current and reachable;
3. use an explicit `--limit <verified-host>`;
4. run `--check` when the playbook supports it.

`start_enable_tailscale_client.yml` may still serve the explicitly named `proxy` and `docker_hosts` Ubuntu groups, so it
is retained pending target verification. The fleet-wide Tailscale installer, NFS client, firewall, K3s, and Rancher
playbooks select legacy inventory groups or all inventory hosts and are not current operations. Talos Tailscale is owned
by `devices/galactic/omni/cluster-template.yaml`; follow `devices/galactic/omni/README.md` for changes.

## Legacy K3s and Rancher playbooks

The K3s HA, K3s OIDC, Rancher, fleet-wide Tailscale, NFS client, and firewall paths are not current `galactic`
operations. Do not run them against Talos. Their live-consumer verification and retirement are tracked in
`docs/repository-cleanup-todo.md`.
