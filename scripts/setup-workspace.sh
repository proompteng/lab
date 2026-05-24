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
BUN_VERSION="1.3.14"

if ! command -v bun >/dev/null 2>&1; then
    echo "Installing Bun ${BUN_VERSION}..."
    curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
    echo "✓ Bun installation complete"
else
    echo "✓ Bun already installed"
fi

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
