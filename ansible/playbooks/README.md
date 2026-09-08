# Tailscale Playbooks for Ubuntu

These playbooks help manage Tailscale on Ubuntu hosts. One installs Tailscale (Ubuntu 24.04 Noble), the other only starts/enables and authenticates an already-installed Tailscale (useful after Harvester bootstrap).

## Prerequisites

- Ansible installed on the control node
- SSH access to all target hosts
- Sudo privileges on target hosts
- All hosts running Ubuntu

## Usage

Run the playbook with:

```bash
# Run with interactive authentication (will provide login URLs)
ansible-playbook -i ../inventory/hosts.ini install_tailscale.yml

# Run with automatic authentication using an authkey
export TAILSCALE_AUTHKEY=tskey-auth-xxxxxxxxxxxx
ansible-playbook -i ../inventory/hosts.ini install_tailscale.yml
```

### Start/Enable/Auth only (no installation)

If Tailscale was installed during Harvester bootstrap, use this playbook to ensure the service is running and authenticate with an auth key:

```bash
# Start and enable tailscaled, authenticate with authkey
export TAILSCALE_AUTHKEY=tskey-auth-xxxxxxxxxxxx
ansible-playbook -i ../inventory/hosts.ini start_enable_tailscale.yml
```

### Client-only (proxy/docker hosts): no tags, no subnets

This playbook is for hosts like `nuc` and `docker-host` that should not request ACL tags or advertise subnet routes. It will print an interactive login URL when login is required:

```bash
ansible-playbook -i ../inventory/hosts.ini start_enable_tailscale_client.yml -l 'proxy:docker_hosts'
```

#### First-time SSH host keys (auto-accept)

To bypass the first-time SSH prompt and auto-accept host keys on your kube hosts:

```bash
ANSIBLE_HOST_KEY_CHECKING=False \
ansible-playbook -i ../inventory/hosts.ini -u kalmyk -b \
  start_enable_tailscale.yml \
  -l 'kube_masters:kube_workers' -f 30 \
  --ssh-extra-args '-o StrictHostKeyChecking=accept-new'
```

You can get an auth key from the [Tailscale Admin Console](https://login.tailscale.com/admin/settings/keys).

## Playbook Details

install_tailscale.yml:

1. Adds the official Tailscale package signing key
2. Adds the Tailscale repository for Ubuntu Noble (24.04)
3. Installs the Tailscale package
4. Starts and enables the Tailscale service
5. Runs `tailscale up` with the authkey from TAILSCALE_AUTHKEY environment variable (if set)
   or without an authkey (interactive authentication) if not set

start_enable_tailscale.yml:

1. Ensures `tailscaled` service is enabled and started
2. Optionally runs `tailscale up` if `TAILSCALE_AUTHKEY` is provided

## Post-Installation

If not using an authkey, after installation, you'll need to authenticate each node to your Tailscale network:

1. Check the logs on each node to find the authentication URL
2. Complete the authentication in a web browser using the URL

Official docs: https://tailscale.com/kb/1187/install-ubuntu-2404
