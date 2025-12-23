---
name: ansible
description: Use this skill when creating, updating, or running Ansible playbooks in this repo (inventory, playbooks, and execution conventions).
---

# Ansible (lab repo)

## When to use
- The request involves Ansible playbooks, inventory, or running `ansible-playbook`.
- The task targets k3s/Harvester nodes, or needs OS package changes across the cluster.

## Repo layout
- Inventory: `ansible/inventory/hosts.ini`
- Playbooks: `ansible/playbooks/*.yml`
- Config: `ansible/ansible.cfg`

## Conventions
- Default remote user for nodes is `kalmyk`.
- Use privilege escalation (`become: true`) for system changes.
- Prefer targeting groups (`k3s_cluster`, `kube_workers`, `kube_masters`) instead of all hosts.
- Keep playbooks minimal and idempotent (package installs, service state, config files).

## Running playbooks
- Standard:
  - `ansible-playbook -i ansible/inventory/hosts.ini <playbook> -u kalmyk -b`
- If first-time SSH host keys block execution:
  - `ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i ansible/inventory/hosts.ini <playbook> --ssh-extra-args '-o StrictHostKeyChecking=accept-new' -u kalmyk -b`

## Example
```bash
ansible-playbook -i ansible/inventory/hosts.ini ansible/playbooks/install_nfs_client.yml -u kalmyk -b
```
