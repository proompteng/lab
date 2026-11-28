#!/usr/bin/env bash
set -euo pipefail

smoke() (
  local temporary
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT
  test -x /usr/bin/env
  for command in bun node codex python3 git gh rg apply_patch openssl uuidgen buf cargo rustc rustfmt clippy-driver cc cmake protoc initdb postgres spicedb agentrun-chromium; do
    command -v "$command" >/dev/null
  done
  /usr/bin/env node --version
  codex --version
  buf --version
  cargo --version
  rustc --version
  rustfmt --version
  postgres --version
  spicedb version
  uuidgen | python3 -c 'import sys, uuid; uuid.UUID(sys.stdin.read().strip())'
  (
    cd "$temporary"
    apply_patch <<'PATCH'
*** Begin Patch
*** Add File: patch-smoke.txt
+agentrun-patch-ok
*** End Patch
PATCH
    grep -Fx agentrun-patch-ok patch-smoke.txt
  )
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=agentrun-smoke \
    -keyout "$temporary/key.pem" -out "$temporary/certificate.pem" 2>/dev/null
  printf 'fn main() { println!("agentrun-rust-ok"); }\n' > "$temporary/main.rs"
  rustc "$temporary/main.rs" -o "$temporary/rust-smoke"
  "$temporary/rust-smoke" | grep -Fx agentrun-rust-ok
  agentrun-chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --screenshot="$temporary/screenshot.png" 'data:text/html,<h1>AgentRun browser acceptance</h1>'
  python3 - "$temporary/screenshot.png" <<'PY'
import pathlib, sys
image = pathlib.Path(sys.argv[1]).read_bytes()
assert image.startswith(b'\x89PNG\r\n\x1a\n') and len(image) > 1000
print('PASS: browser rendered a PNG')
PY
  printf 'PASS: AgentRun toolchain smoke\n'
)

if [[ "${1:-}" == --smoke ]]; then
  smoke
  exit
fi

repository="${1:-/workspace/lab}"
output="${2:-/workspace/.agent/acceptance}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
rm -f "$output/result.json"
cd "$repository"
smoke 2>&1 | tee "$output/toolchain.log"
buf lint --path proto/proompteng/authz --path proto/proompteng/relay 2>&1 | tee "$output/contracts.log"
bun install --frozen-lockfile --ignore-scripts \
  --filter @proompteng/source --filter landing --filter @proompteng/backend --filter @proompteng/design
# shellcheck disable=SC2016
bun -e '
  import { createRequire } from "node:module";
  const require = createRequire(process.cwd() + "/apps/landing/package.json");
  const version = require("@playwright/test/package.json").version;
  if (version !== process.env.AGENTRUN_PLAYWRIGHT_VERSION)
    throw new Error(`Runner Playwright ${process.env.AGENTRUN_PLAYWRIGHT_VERSION} differs from checkout ${version}`);
'
PLATFORM_UI_SCREENSHOT_DIR="$output/screenshots" \
  bun test apps/landing/src/components/platform/admin-portal.e2e.test.ts 2>&1 | tee "$output/browser.log"
bash services/ofz/test-control.sh platform 2>&1 | tee "$output/platform.log"
bash services/ofz/test-policy.sh 2>&1 | tee "$output/policy.log"
bash services/ofz/qualify-platform.sh 2>&1 | tee "$output/qualification.log"
python3 - "$output" <<'PY'
import json, pathlib, sys
output = pathlib.Path(sys.argv[1])
screenshots = sorted(str(p.relative_to(output)) for p in output.glob('screenshots/*.png'))
assert screenshots, 'Browser acceptance did not retain any screenshots'
(output / 'result.json').write_text(json.dumps({'status': 'passed', 'checks': ['toolchain', 'contracts', 'browser', 'platform', 'policy', 'qualification'], 'screenshots': screenshots}, indent=2) + '\n')
print('PASS: fresh-image acceptance, including real Ofz fixtures and screenshots')
PY
