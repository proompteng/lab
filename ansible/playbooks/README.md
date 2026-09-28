# Ubuntu host playbooks

Status: Retained for explicitly verified Ubuntu hosts.

These playbooks do not manage Talos nodes. The checked-in inventory contains legacy K3s/Rancher groups, so inspect the
inventory and playbook host selector before every run, use an explicit `--limit <verified-host>`, and prefer `--check`
when supported.

The only narrowly targeted utility that may still serve current Ubuntu hosts is:

- `start_enable_tailscale_client.yml`

It selects only `proxy:docker_hosts`; verify both targets and use an explicit `--limit` before running it. The K3s,
Rancher, NFS client, firewall, and fleet-wide Tailscale playbooks select legacy groups or all inventory hosts and are
legacy pending the verification and retirement work in `docs/repository-cleanup-todo.md`. Current Talos Tailscale
configuration is owned by `devices/galactic/omni/cluster-template.yaml`.
