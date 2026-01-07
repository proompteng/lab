terraform {
  required_providers {
    coder = {
      source = "coder/coder"
    }
    kubernetes = {
      source = "hashicorp/kubernetes"
    }
  }
}

provider "coder" {
}

variable "use_kubeconfig" {
  type        = bool
  description = <<-EOF
  Use host kubeconfig? (true/false)

  Set this to false if the Coder host is itself running as a Pod on the same
  Kubernetes cluster as you are deploying workspaces to.

  Set this to true if the Coder host is running outside the Kubernetes cluster
  for workspaces.  A valid "~/.kube/config" must be present on the Coder host.
  EOF
  default     = false
}

variable "namespace" {
  type        = string
  description = "The Kubernetes namespace to create workspaces in (must exist prior to creating workspaces). If the Coder host is itself running as a Pod on the same Kubernetes cluster as you are deploying workspaces to, set this to the same namespace."
  default     = "coder"
}

data "coder_parameter" "cpu" {
  name         = "cpu"
  display_name = "CPU"
  description  = "The number of CPU cores"
  default      = "4"
  icon         = "/icon/memory.svg"
  mutable      = true
  option {
    name  = "4 Cores"
    value = "4"
  }
  option {
    name  = "6 Cores"
    value = "6"
  }
  option {
    name  = "8 Cores"
    value = "8"
  }
}

data "coder_parameter" "memory" {
  name         = "memory"
  display_name = "Memory"
  description  = "The amount of memory in GB"
  default      = "8"
  icon         = "/icon/memory.svg"
  mutable      = true
  option {
    name  = "4 GB"
    value = "4"
  }
  option {
    name  = "6 GB"
    value = "6"
  }
  option {
    name  = "8 GB"
    value = "8"
  }
}

data "coder_parameter" "home_disk_size" {
  name         = "home_disk_size"
  display_name = "Home disk size"
  description  = "The size of the home disk in GB"
  default      = "30"
  type         = "number"
  icon         = "/emojis/1f4be.png"
  mutable      = false
  validation {
    min = 1
    max = 99999
  }
}

data "coder_parameter" "repository_url" {
  name         = "repository_url"
  display_name = "Repository URL"
  description  = "Git URL to clone into the workspace"
  default      = "https://github.com/proompteng/lab"
  icon         = "/icon/git-branch.svg"
  mutable      = true
}

data "coder_parameter" "repository_directory" {
  name         = "repository_directory"
  display_name = "Checkout directory"
  description  = "Parent directory for the cloned repository"
  default      = "~/github.com"
  icon         = "/icon/folder.svg"
  mutable      = true
}

locals {
  repository_url           = trimspace(data.coder_parameter.repository_url.value)
  repository_directory_raw = trimspace(trimsuffix(data.coder_parameter.repository_directory.value, "/"))
  repository_directory     = local.repository_directory_raw != "" ? local.repository_directory_raw : "~/github.com"
  repository_name          = try(regex("[^/]+(?=\\.git$|$)", local.repository_url), "workspace")
  repository_folder        = "${local.repository_directory}/${local.repository_name}"
}

provider "kubernetes" {
  # Authenticate via ~/.kube/config or a Coder-specific ServiceAccount, depending on admin preferences
  config_path = var.use_kubeconfig == true ? "~/.kube/config" : null
}

data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

resource "coder_agent" "main" {
  os             = "linux"
  arch           = "arm64"
  startup_script = <<-EOT
    set -e

    # Install the latest code-server.
    # Append "--version x.x.x" to install a specific version of code-server.
    curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix=/tmp/code-server

    # Start code-server in the background.
    /tmp/code-server/bin/code-server --auth none --port 13337 >/tmp/code-server.log 2>&1 &
  EOT

  # The following metadata blocks are optional. They are used to display
  # information about your workspace in the dashboard. You can remove them
  # if you don't want to display any information.
  # For basic resources, you can use the `coder stat` command.
  # If you need more control, you can write your own script.
  metadata {
    display_name = "CPU Usage"
    key          = "0_cpu_usage"
    script       = "coder stat cpu"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "RAM Usage"
    key          = "1_ram_usage"
    script       = "coder stat mem"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Home Disk"
    key          = "3_home_disk"
    script       = "coder stat disk --path $${HOME}"
    interval     = 60
    timeout      = 1
  }

  metadata {
    display_name = "CPU Usage (Host)"
    key          = "4_cpu_usage_host"
    script       = "coder stat cpu --host"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Memory Usage (Host)"
    key          = "5_mem_usage_host"
    script       = "coder stat mem --host"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Load Average (Host)"
    key          = "6_load_host"
    # get load avg scaled by number of cores
    script   = <<EOT
      echo "`cat /proc/loadavg | awk '{ print $1 }'` `nproc`" | awk '{ printf "%0.2f", $1/$2 }'
    EOT
    interval = 60
    timeout  = 1
  }
}

# code-server
resource "coder_app" "code-server" {
  agent_id     = coder_agent.main.id
  slug         = "code-server"
  display_name = "code-server"
  icon         = "/icon/code.svg"
  url          = "http://localhost:13337?folder=/home/coder"
  subdomain    = false
  share        = "owner"

  healthcheck {
    url       = "http://localhost:13337/healthz"
    interval  = 3
    threshold = 10
  }
}

resource "kubernetes_persistent_volume_claim" "home" {
  metadata {
    name      = "coder-${data.coder_workspace.me.id}-home"
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"     = "coder-pvc"
      "app.kubernetes.io/instance" = "coder-pvc-${data.coder_workspace.me.id}"
      "app.kubernetes.io/part-of"  = "coder"
      //Coder-specific labels.
      "com.coder.resource"       = "true"
      "com.coder.workspace.id"   = data.coder_workspace.me.id
      "com.coder.workspace.name" = data.coder_workspace.me.name
      "com.coder.user.id"        = data.coder_workspace_owner.me.id
      "com.coder.user.username"  = data.coder_workspace_owner.me.name
    }
    annotations = {
      "com.coder.user.email" = data.coder_workspace_owner.me.email
    }
  }
  wait_until_bound = false
  spec {
    access_modes = ["ReadWriteOnce"]
    resources {
      requests = {
        storage = "${data.coder_parameter.home_disk_size.value}Gi"
      }
    }
  }
}

resource "kubernetes_service_account" "workspace_admin" {
  count = data.coder_workspace.me.start_count
  metadata {
    name      = "coder-workspace-${data.coder_workspace.me.id}"
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"     = "coder-workspace"
      "app.kubernetes.io/instance" = "coder-workspace-${data.coder_workspace.me.id}"
      "app.kubernetes.io/part-of"  = "coder"
      "com.coder.resource"         = "true"
      "com.coder.workspace.id"     = data.coder_workspace.me.id
      "com.coder.workspace.name"   = data.coder_workspace.me.name
      "com.coder.user.id"          = data.coder_workspace_owner.me.id
      "com.coder.user.username"    = data.coder_workspace_owner.me.name
    }
    annotations = {
      "com.coder.user.email" = data.coder_workspace_owner.me.email
    }
  }
  automount_service_account_token = true
}

resource "kubernetes_cluster_role_binding" "workspace_admin" {
  count = data.coder_workspace.me.start_count
  metadata {
    name = "coder-workspace-${data.coder_workspace.me.id}-cluster-admin"
    labels = {
      "app.kubernetes.io/name"     = "coder-workspace"
      "app.kubernetes.io/instance" = "coder-workspace-${data.coder_workspace.me.id}"
      "app.kubernetes.io/part-of"  = "coder"
      "com.coder.resource"         = "true"
      "com.coder.workspace.id"     = data.coder_workspace.me.id
      "com.coder.workspace.name"   = data.coder_workspace.me.name
      "com.coder.user.id"          = data.coder_workspace_owner.me.id
      "com.coder.user.username"    = data.coder_workspace_owner.me.name
    }
    annotations = {
      "com.coder.user.email" = data.coder_workspace_owner.me.email
    }
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = "cluster-admin"
  }
  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account.workspace_admin[0].metadata[0].name
    namespace = var.namespace
  }
}

resource "kubernetes_deployment" "main" {
  count = data.coder_workspace.me.start_count
  depends_on = [
    kubernetes_persistent_volume_claim.home,
    kubernetes_cluster_role_binding.workspace_admin
  ]
  wait_for_rollout = false
  metadata {
    name      = "coder-${data.coder_workspace.me.id}"
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"     = "coder-workspace"
      "app.kubernetes.io/instance" = "coder-workspace-${data.coder_workspace.me.id}"
      "app.kubernetes.io/part-of"  = "coder"
      "com.coder.resource"         = "true"
      "com.coder.workspace.id"     = data.coder_workspace.me.id
      "com.coder.workspace.name"   = data.coder_workspace.me.name
      "com.coder.user.id"          = data.coder_workspace_owner.me.id
      "com.coder.user.username"    = data.coder_workspace_owner.me.name
    }
    annotations = {
      "com.coder.user.email" = data.coder_workspace_owner.me.email
    }
  }

  spec {
    replicas = 1
    selector {
      match_labels = {
        "app.kubernetes.io/name"     = "coder-workspace"
        "app.kubernetes.io/instance" = "coder-workspace-${data.coder_workspace.me.id}"
        "app.kubernetes.io/part-of"  = "coder"
        "com.coder.resource"         = "true"
        "com.coder.workspace.id"     = data.coder_workspace.me.id
        "com.coder.workspace.name"   = data.coder_workspace.me.name
        "com.coder.user.id"          = data.coder_workspace_owner.me.id
        "com.coder.user.username"    = data.coder_workspace_owner.me.name
      }
    }
    strategy {
      type = "Recreate"
    }

    template {
      metadata {
        labels = {
          "app.kubernetes.io/name"     = "coder-workspace"
          "app.kubernetes.io/instance" = "coder-workspace-${data.coder_workspace.me.id}"
          "app.kubernetes.io/part-of"  = "coder"
          "com.coder.resource"         = "true"
          "com.coder.workspace.id"     = data.coder_workspace.me.id
          "com.coder.workspace.name"   = data.coder_workspace.me.name
          "com.coder.user.id"          = data.coder_workspace_owner.me.id
          "com.coder.user.username"    = data.coder_workspace_owner.me.name
        }
      }
      spec {
        service_account_name            = kubernetes_service_account.workspace_admin[0].metadata[0].name
        automount_service_account_token = true
        security_context {
          run_as_user     = 1000
          fs_group        = 1000
          run_as_non_root = true
        }

        container {
          name              = "dev"
          image             = "codercom/enterprise-base:ubuntu"
          image_pull_policy = "Always"
          command           = ["sh", "-c", replace(coder_agent.main.init_script, "coder-linux-amd64", "coder-linux-arm64")]
          security_context {
            run_as_user = "1000"
          }
          env {
            name  = "CODER_AGENT_TOKEN"
            value = coder_agent.main.token
          }
          resources {
            requests = {
              "cpu"    = "250m"
              "memory" = "512Mi"
            }
            limits = {
              "cpu"    = "${data.coder_parameter.cpu.value}"
              "memory" = "${data.coder_parameter.memory.value}Gi"
            }
          }
          volume_mount {
            mount_path = "/home/coder"
            name       = "home"
            read_only  = false
          }
        }

        volume {
          name = "home"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim.home.metadata.0.name
            read_only  = false
          }
        }

        affinity {
          // This affinity attempts to spread out all workspace pods evenly across
          // nodes.
          pod_anti_affinity {
            preferred_during_scheduling_ignored_during_execution {
              weight = 1
              pod_affinity_term {
                topology_key = "kubernetes.io/hostname"
                label_selector {
                  match_expressions {
                    key      = "app.kubernetes.io/name"
                    operator = "In"
                    values   = ["coder-workspace"]
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

module "git-clone" {
  source   = "registry.coder.com/coder/git-clone/coder"
  version  = "1.1.1"
  agent_id = coder_agent.main.id
  url      = local.repository_url
  base_dir = local.repository_directory
}

module "cursor" {
  source     = "registry.coder.com/coder/cursor/coder"
  version    = "1.3.2"
  agent_id   = coder_agent.main.id
  folder     = local.repository_folder
  depends_on = [module.git-clone]
}

resource "coder_script" "bootstrap_tools" {
  agent_id           = coder_agent.main.id
  display_name       = "Bootstrap developer tools"
  run_on_start       = true
  start_blocks_login = true
  script             = <<-EOT
    #!/usr/bin/env bash
    set -euo pipefail

    log() {
      printf '[bootstrap] %s\n' "$1" | tee -a "$LOG_FILE"
    }

    fail() {
      printf '[bootstrap][error] %s\n' "$1" | tee -a "$LOG_FILE" >&2
      exit 1
    }

    LOG_DIR="/tmp/coder-bootstrap"
    mkdir -p "$LOG_DIR"
    LOG_FILE="$LOG_DIR/bootstrap.log"
    log "Starting developer tool bootstrap"
    touch "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"

    export PATH="$HOME/.local/bin:$PATH"
    export BUN_INSTALL="$HOME/.bun"
    mkdir -p "$BUN_INSTALL" "$HOME/.local/bin" /tmp/coder-script-data/bin
    case ":$PATH:" in
      *:"$BUN_INSTALL/bin":*) ;;
      *) export PATH="$BUN_INSTALL/bin:$PATH" ;;
    esac

    if ! command -v bun >/dev/null 2>&1; then
      log "Installing Bun runtime"
      if ! curl -fsSL https://bun.sh/install | bash >"$LOG_DIR/bun-install.log" 2>&1; then
        fail "Bun install failed; see $LOG_DIR/bun-install.log"
      fi
      hash -r
    fi

    if ! command -v bun >/dev/null 2>&1; then
      fail "Bun not found after install; see $LOG_DIR/bun-install.log"
    fi

    if command -v bun >/dev/null 2>&1; then
      BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
      log "bun $BUN_VERSION ready"
    fi

    if ! command -v convex >/dev/null 2>&1; then
      log "Installing Convex CLI"
      if ! bun add -g convex@1.27.0 >"$LOG_DIR/convex-install.log" 2>&1; then
        fail "Convex CLI install failed; see $LOG_DIR/convex-install.log"
      fi
    fi

    if ! command -v codex >/dev/null 2>&1; then
      log "Installing OpenAI Codex CLI"
      if ! bun install -g @openai/codex >"$LOG_DIR/codex-install.log" 2>&1; then
        fail "Codex CLI install failed; see $LOG_DIR/codex-install.log"
      fi
    fi
    CODEX_BIN="$BUN_INSTALL/bin/codex"
    if [ ! -x "$CODEX_BIN" ]; then
      fail "Codex CLI not found at $CODEX_BIN; check $LOG_DIR/codex-install.log"
    fi
    ln -sf "$CODEX_BIN" /tmp/coder-script-data/bin/codex

    if ! command -v kubectl >/dev/null 2>&1; then
      log "Installing kubectl"
      KUBECTL_ARCH="$(uname -m)"
      case "$KUBECTL_ARCH" in
        aarch64|arm64) KUBECTL_ARCH="arm64" ;;
        x86_64|amd64)  KUBECTL_ARCH="amd64" ;;
        *)             KUBECTL_ARCH="amd64" ;;
      esac
      KUBECTL_VERSION="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
      if ! curl -fsSLo "$HOME/.local/bin/kubectl" "https://dl.k8s.io/release/$${KUBECTL_VERSION}/bin/linux/$${KUBECTL_ARCH}/kubectl" 2>"$LOG_DIR/kubectl-install.log"; then
        fail "kubectl download failed; see $LOG_DIR/kubectl-install.log"
      fi
      chmod +x "$HOME/.local/bin/kubectl"
      ln -sf "$HOME/.local/bin/kubectl" /tmp/coder-script-data/bin/kubectl
    fi

    if ! command -v argocd >/dev/null 2>&1; then
      log "Installing Argo CD CLI"
      ARGOCD_ARCH="$(uname -m)"
      case "$ARGOCD_ARCH" in
        aarch64|arm64) ARGOCD_ARCH="arm64" ;;
        x86_64|amd64)  ARGOCD_ARCH="amd64" ;;
        *)             ARGOCD_ARCH="amd64" ;;
      esac
      if ! curl -fsSLo "$HOME/.local/bin/argocd" "https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-$${ARGOCD_ARCH}" 2>"$LOG_DIR/argocd-install.log"; then
        fail "Argo CD CLI download failed; see $LOG_DIR/argocd-install.log"
      fi
      chmod +x "$HOME/.local/bin/argocd"
      ln -sf "$HOME/.local/bin/argocd" /tmp/coder-script-data/bin/argocd
    fi

    if ! command -v gh >/dev/null 2>&1; then
      log "Installing GitHub CLI"
      GH_ARCH="$(uname -m)"
      case "$GH_ARCH" in
        aarch64|arm64) GH_ARCH="arm64" ;;
        x86_64|amd64)  GH_ARCH="amd64" ;;
        *)             GH_ARCH="amd64" ;;
      esac
      GH_VERSION="2.55.0"
      GH_JSON=""
      if GH_JSON="$(curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors https://api.github.com/repos/cli/cli/releases/latest 2>"$LOG_DIR/gh-version.log")"; then
        GH_VERSION="$(printf '%s' "$GH_JSON" | grep -m1 '\"tag_name\"' | sed -E 's/.*\"tag_name\": *\"v?([^\" ]+)\".*/\\1/')"
      fi
      if [ -z "$GH_VERSION" ]; then
        GH_VERSION="2.55.0"
        log "Unable to determine latest GitHub CLI version; falling back to $GH_VERSION"
      fi
      GH_TMP="$(mktemp -d)"
      GH_TAR="$GH_TMP/gh.tar.gz"
      if ! curl -fsSLo "$GH_TAR" "https://github.com/cli/cli/releases/download/v$${GH_VERSION}/gh_$${GH_VERSION}_linux_$${GH_ARCH}.tar.gz" 2>"$LOG_DIR/gh-install.log"; then
        rm -rf "$GH_TMP"
        fail "GitHub CLI download failed; see $LOG_DIR/gh-install.log"
      fi
      if ! tar -xzf "$GH_TAR" -C "$GH_TMP" >>"$LOG_DIR/gh-install.log" 2>&1; then
        rm -rf "$GH_TMP"
        fail "GitHub CLI extract failed; see $LOG_DIR/gh-install.log"
      fi
      GH_DIR="$(find "$GH_TMP" -maxdepth 1 -type d -name 'gh_*' | head -n1)"
      if [ -z "$GH_DIR" ] || [ ! -x "$GH_DIR/bin/gh" ]; then
        rm -rf "$GH_TMP"
        fail "GitHub CLI archive missing expected binary; see $LOG_DIR/gh-install.log"
      fi
      install -m 0755 "$GH_DIR/bin/gh" "$HOME/.local/bin/gh"
      ln -sf "$HOME/.local/bin/gh" /tmp/coder-script-data/bin/gh
      rm -rf "$GH_TMP"
    fi

    if ! grep -q "BUN_INSTALL" "$HOME/.profile" 2>/dev/null; then
      cat <<'PROFILE' >> "$HOME/.profile"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
PROFILE
    fi

    if ! grep -q "BUN_INSTALL" "$HOME/.bashrc" 2>/dev/null; then
      cat <<'BASHRC' >> "$HOME/.bashrc"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
BASHRC
    fi

    if ! grep -q "BUN_INSTALL" "$HOME/.zshrc" 2>/dev/null; then
      cat <<'ZSHRC' >> "$HOME/.zshrc"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
ZSHRC
    fi

    REPO_ROOT="${local.repository_folder}"
    case "$REPO_ROOT" in
      ~*) REPO_ROOT="$${HOME}$${REPO_ROOT#~}" ;;
    esac

    if [ ! -d "$REPO_ROOT/.git" ]; then
      for candidate in "$${REPO_ROOT%/*}"/*; do
        if [ -d "$candidate/.git" ]; then
          REPO_ROOT="$candidate"
          log "Detected cloned repository at $REPO_ROOT"
          break
        fi
      done
    fi

    if [ -d "$REPO_ROOT/.git" ]; then
      if [ -f "$REPO_ROOT/bun.lockb" ] || [ -f "$REPO_ROOT/bun.lock" ]; then
        log "Installing workspace dependencies with bun"
        if ! (cd "$REPO_ROOT" && bun install --frozen-lockfile >"$LOG_DIR/bun-install.log" 2>&1); then
          fail "bun install failed; see $LOG_DIR/bun-install.log"
        fi
      elif [ -f "$REPO_ROOT/package.json" ]; then
        log "Installing workspace dependencies with bun (no lockfile)"
        if ! (cd "$REPO_ROOT" && bun install >"$LOG_DIR/bun-install.log" 2>&1); then
          fail "bun install failed; see $LOG_DIR/bun-install.log"
        fi
      else
        log "No JS manifest found in $REPO_ROOT; skipping dependency install"
      fi
    else
      log "Repository directory '$REPO_ROOT' not found; skipping dependency install"
    fi

    log "Bootstrap complete"
  EOT

  depends_on = [module.git-clone]
}
