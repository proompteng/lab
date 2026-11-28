#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=services/devbox/profile.sh
source /etc/profile.d/devbox.sh
test "$(id -un)" = codex
test -d "$HOME/src/lab/.git"
test -d "$HOME/.codex/skills/poteto-mode"
test -f "$HOME/.codex/memories/MEMORY.md"
test -f /run/devbox-ready
cd "$HOME/src/lab"
nix develop --command toolchain-doctor
codex --version
rustc --version
cargo --version
docker version
docker run --rm hello-world
bun run --filter @proompteng/codex build
(cd services/bumba && node -e 'require("tree-sitter-json")')
bun -e 'const { chromium } = require("@playwright/test"); const browser = await chromium.launch(); const page = await browser.newPage(); await page.setContent("<title>devbox-ready</title>"); if (await page.title() !== "devbox-ready") throw new Error("browser check failed"); await browser.close();'
(cd services/nanoagent && GOWORK=off go test ./...)
kubectl --context galactic-lan -n default auth whoami
kubectl --context galactic-lan -n default get --raw=/version
printf 'devbox development checks passed\n'
