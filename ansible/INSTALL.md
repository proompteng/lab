# Installing Ansible

## On macOS

```bash
# Using Homebrew
brew install ansible

# Using pip
pip install ansible
```

## On Ubuntu/Debian

```bash
# Add repository and install
sudo apt update
sudo apt install software-properties-common
sudo add-apt-repository --yes --update ppa:ansible/ansible
sudo apt install ansible

# Or using pip
sudo apt update
sudo apt install python3-pip
pip3 install ansible
```

## Verifying Installation

```bash
ansible --version
```

## Running the Tailscale Playbook

Once Ansible is installed:

```bash
cd ansible
ansible-playbook -i inventory/hosts.ini playbooks/install_tailscale.yml
# Start/restart the daemon on the Kubernetes nodes only (k3s_cluster)
ansible-playbook -i inventory/hosts.ini playbooks/start_enable_tailscale.yml
# Start Tailscale on non-router hosts (proxy/docker hosts): no tags, no subnets (interactive login URL)
ansible-playbook -i inventory/hosts.ini playbooks/start_enable_tailscale_client.yml
```

If you need to fan the run out across all Kubernetes masters and workers at once (30 parallel forks), while passing an auth key from the shell and relaxing host-key checks for newly rebuilt nodes:

```bash
ANSIBLE_CONFIG=ansible/ansible.cfg \
  TAILSCALE_AUTHKEY="${TAILSCALE_AUTHKEY}" \
  ansible-playbook -i ansible/inventory/hosts.ini -u kalmyk -b \
    ansible/playbooks/start_enable_tailscale.yml \
    -l 'kube_masters:kube_workers' -f 30 \
    --ssh-extra-args '-o StrictHostKeyChecking=accept-new'
```

The Tailscale playbooks are designed to take settings from environment variables (for example `TAILSCALE_AUTHKEY`). If you add a Vault-encrypted `ansible/inventory/group_vars/all/tailscale.yml`/`.yaml`, you'll need to provide vault secrets (`--ask-vault-pass` or `--vault-password-file`).

## Installing the K3s Cluster (official playbook wrapper)

1. Install the official K3s Ansible collection:

   ```bash
   cd ansible
   ansible-galaxy collection install -r collections/requirements.yml
   ```

2. Update `inventory/group_vars/k3s_cluster.yml` with a secure `token` (use `ansible-vault` or an environment-specific override) and tweak any optional settings.

3. Run the wrapper playbook, which delegates to `k3s.orchestration.site` from the official collection:

   ```bash
   ansible-playbook -i inventory/hosts.ini playbooks/k3s-ha.yml
   ```

The official collection handles bootstrapping the first server, joining the remaining control-plane nodes, and enrolling all agents while honoring the configuration defined in `k3s_cluster.yml`.

## Updating K3s OIDC Settings (existing cluster)

This repo includes a playbook to apply OIDC args to the k3s API servers via a config drop-in on control-plane nodes:

```bash
ansible-playbook -i inventory/hosts.ini playbooks/k3s-oidc.yml
```

Override defaults if needed:

```bash
ansible-playbook -i inventory/hosts.ini playbooks/k3s-oidc.yml \\
  --extra-vars 'k3s_oidc_client_id=kubernetes k3s_oidc_issuer_url=https://auth.proompteng.ai/realms/master'
```
