#!/usr/bin/env bash

echo "🚀 Setting up development environment..."

# Setup Git configuration
echo "⚙️ Configuring Git..."
git config --global init.defaultBranch main
git config --global core.editor "cursor --wait"
git config --global pull.rebase true
git config --global rebase.autoStash true
git config --global user.name "Greg Konush"
git config --global user.email "12027037+gregkonush@users.noreply.github.com"
git config --global push.autoSetupRemote true
echo "✓ Git configuration complete"

# Install nvm
echo "📦 Setting up NVM..."
if [ ! -d "$HOME/.nvm" ]; then
    echo "Installing nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    echo "✓ NVM installation complete"
else
    echo "✓ NVM already installed"
fi

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

nvm install

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
BUN_VERSION="1.4.0"

# BEGIN Bun runtime bootstrap
CURRENT_BUN_VERSION=""
if command -v bun >/dev/null 2>&1; then
    CURRENT_BUN_VERSION=$(bun --version 2>/dev/null || true)
fi

if [ "$CURRENT_BUN_VERSION" != "$BUN_VERSION" ]; then
    if [ -n "$CURRENT_BUN_VERSION" ]; then
        echo "Upgrading Bun from ${CURRENT_BUN_VERSION} to ${BUN_VERSION}..."
    else
        echo "Installing Bun ${BUN_VERSION}..."
    fi
    if ! (set -o pipefail; curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"); then
        echo "Bun ${BUN_VERSION} installation failed" >&2
        exit 1
    fi
    hash -r
    echo "✓ Bun installation complete"
fi

if ! command -v bun >/dev/null 2>&1; then
    echo "Bun was not found after installing ${BUN_VERSION}" >&2
    exit 1
fi

INSTALLED_BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
if [ "$INSTALLED_BUN_VERSION" != "$BUN_VERSION" ]; then
    echo "Bun version mismatch after install: expected ${BUN_VERSION}, got ${INSTALLED_BUN_VERSION}" >&2
    exit 1
fi
echo "✓ Bun ${INSTALLED_BUN_VERSION} ready"
# END Bun runtime bootstrap

echo "📦 Installing workspace dependencies with Bun..."
bun install

(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) \
	&& sudo mkdir -p -m 755 /etc/apt/keyrings \
        && out=$(mktemp) && wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        && sudo install -m 644 "$out" /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& sudo apt update \
	&& sudo apt install gh -y
