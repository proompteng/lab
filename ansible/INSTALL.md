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
# Start/restart the daemon on the Kubernetes nodes only (excludes proxy hosts like nuc)
ansible-playbook -i inventory/hosts.ini playbooks/start_enable_tailscale.yml
```

If you need to fan the run out across all Kubernetes masters and workers at once (30 parallel forks), while passing an auth key from the shell and relaxing host-key checks for newly rebuilt nodes:

```bash
ANSIBLE_CONFIG=ansible/ansible.cfg \
  TAILSCALE_AUTHKEY="${TAILSCALE_AUTHKEY}" \
  ansible-playbook -i ansible/inventory/hosts.ini -u kalmyk -b \
    ansible/playbooks/start_enable_tailscale.yml \
    -l 'kube_masters:kube_workers' -f 30 \
    --ssh-extra-args '-o StrictHostKeyChecking=accept-new' \
    --ask-vault-pass
```

### Supplying the Ansible Vault password

- Prompt each run:

  ```bash
  ansible-playbook -i inventory/hosts.ini playbooks/start_enable_tailscale.yml --ask-vault-pass
  ```

- Avoid the prompt by creating a password file outside the repo, for example `~/.config/ansible/vault/tailscale.pass`, with 700 perms on the directory and 600 on the file, then:

  ```bash
  ansible-playbook -i inventory/hosts.ini \
    playbooks/start_enable_tailscale.yml \
    --vault-password-file ~/.config/ansible/vault/tailscale.pass
  ```

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
