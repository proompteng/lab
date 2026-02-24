# Tooling Setup (October 20 2025)

This guide consolidates the CLI and runtime tooling we keep standardised across the lab workspaces. Examples below assume macOS with Homebrew; when a Linux alternative is materially different we call it out. Use these instructions alongside the Coder bootstrap script so local environments and cloud workspaces stay aligned.

## Node.js and Bun

- **Node.js** – Target the Active LTS line (24.x) which receives security fixes through April 30 2028 (see the [Node.js release schedule](https://nodejs.org/en/about/previous-releases)).  
  Workspaces ship with `nvm` preinstalled. To match production:
  ```bash
  nvm install 24.11.1
  nvm alias default 24.11.1
  ```
- **Bun** – Default package manager/runtime (1.3.x). Install from the official script documented on bun.sh:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
  (See [Bun installation docs](https://bun.sh/docs/installation) for platform notes.)

## OpenTofu / Terraform

- The IaC directories under `tofu/` rely on OpenTofu; follow the [official installation guide](https://opentofu.org/docs/intro/install/). Install via Homebrew:
  ```bash
  brew install opentofu
  ```
- We still keep `terraform` available for legacy modules:
  ```bash
  brew install terraform
  ```
- CLI wrappers such as `bun run tf:plan` invoke OpenTofu; when contributing Terraform modules, test with both CLIs if you expect upstream consumers.

## Kubernetes Tooling

- Install `kubectl` following the upstream guidance from [kubernetes.io](https://kubernetes.io/docs/tasks/tools/):
  ```bash
  brew install kubectl
  ```
  (Reference: [Kubernetes install guide](https://kubernetes.io/docs/tasks/tools/).)
- Optional helpers:
  - `./kubernetes/install.sh` seeds the base manifests for local clusters.
  - Place shared kubeconfigs under `~/.kube` (for example `~/.kube/altra.yaml`) and export `KUBECONFIG` when switching contexts.

## Ansible

Used for host bootstrap and configuration stored under `ansible/`. Install from Homebrew (or follow the [Ansible installation guide](https://docs.ansible.com/ansible/latest/installation_guide/installation_distros.html) for other OSes):

```bash
brew install ansible
```

## PostgreSQL Client Utilities

- macOS:
  ```bash
  brew install postgresql
  ```
- Ubuntu:
  ```bash
  sudo apt update && sudo apt install postgresql-client
  ```
  Check the main repository README for connection parameters and authentication requirements when targeting CloudNativePG clusters.

## Python Tooling

We standardise on Python 3.12 for automation scripts.

- pyenv installs via Homebrew per the [upstream instructions](https://github.com/pyenv/pyenv#installation):
  ```bash
  brew install pyenv
  pyenv install 3.12.5
  ```
- Install pipx to manage isolated CLI tools ([pipx docs](https://pipx.pypa.io/stable/installation/)):
  ```bash
  brew install pipx
  pipx ensurepath
  ```
- Install Poetry (used by several helper scripts) via pipx ([Poetry install guide](https://python-poetry.org/docs/#installing-with-pipx)):
  ```bash
  pipx install poetry
  ```

## GitHub CLI

Automation scripts under `scripts/` depend on `gh` for release management and PR operations. Install from Homebrew or the [official GitHub CLI installer](https://cli.github.com/manual/installation):

```bash
brew install gh
```

---

Refer back to the repository README for service-specific workflows, deployment commands, and infra runbooks once these core tools are available.
