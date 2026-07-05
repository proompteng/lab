{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
  exact,
  repoRevision ? "dirty",
}:

let
  codexCli = import ./openai-codex-cli.nix { inherit pkgs; };
  kubectl = exact.kubectl or pkgs.kubectl;

  scriptWrapper =
    name: target:
    pkgs.writeShellScriptBin name ''
      exec ${bun}/bin/bun ${target} "$@"
    '';

  cxTools = [
    (scriptWrapper "codex-nats-publish" "/app/packages/cx-tools/dist/codex-nats-publish.js")
    (scriptWrapper "codex-nats-soak" "/app/packages/cx-tools/dist/codex-nats-soak.js")
    (scriptWrapper "cx-codex-run" "/app/packages/cx-tools/dist/cx-codex-run.js")
    (scriptWrapper "cx-workflow-cancel" "/app/packages/cx-tools/dist/cx-workflow-cancel.js")
    (scriptWrapper "cx-workflow-query" "/app/packages/cx-tools/dist/cx-workflow-query.js")
    (scriptWrapper "cx-workflow-signal" "/app/packages/cx-tools/dist/cx-workflow-signal.js")
    (scriptWrapper "cx-workflow-start" "/app/packages/cx-tools/dist/cx-workflow-start.js")
  ];

  entrypoint = pkgs.writeShellScriptBin "jangar-entrypoint" ''
    set -euo pipefail

    mkdir -p "''${VSCODE_DATA_DIR:-/workspace/.ovscode}" "''${VSCODE_DEFAULT_FOLDER:-/workspace/lab}"

    if command -v openvscode-server >/dev/null 2>&1; then
      openvscode-server \
        --host 0.0.0.0 \
        --port "''${VSCODE_PORT:-8081}" \
        --disable-telemetry \
        --without-connection-token \
        --user-data-dir "''${VSCODE_DATA_DIR:-/workspace/.ovscode}" \
        --extensions-dir "''${VSCODE_DATA_DIR:-/workspace/.ovscode}/extensions" \
        --default-folder "''${VSCODE_DEFAULT_FOLDER:-/workspace/lab}" &
      vscode_pid="$!"
      trap 'kill "$vscode_pid" 2>/dev/null || true' EXIT
    fi

    cd /app/services/jangar
    exec ${bun}/bin/bun run .output/server/index.mjs
  '';
in
import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "jangar";
  packageName = "@proompteng/jangar";
  depsHash = {
    x86_64-linux = "sha256-qT9oNXW4rDnQD/YVGb6oKK0cfbSzMFUuWdFEnM8P1sM=";
    aarch64-linux = "sha256-tCsbYTGtLtJfKYC3sULqwYj4AOGYmf9lyGt2cDcAeqk=";
  };
  dependencyClosure = "bunCache";
  installFilters = [
    "@proompteng/agent-contracts"
    "@proompteng/bumba"
    "@proompteng/codex"
    "@proompteng/cx-tools"
    "@proompteng/design"
    "@proompteng/discord"
    "@proompteng/jangar"
    "@proompteng/otel"
    "@proompteng/temporal-bun-sdk"
  ];
  sourcePaths = [
    "packages/agent-contracts"
    "packages/codex"
    "packages/cx-tools"
    "packages/design"
    "packages/discord"
    "packages/otel"
    "packages/temporal-bun-sdk"
    "services/bumba"
    "services/jangar"
  ];
  buildCommands = [
    "patchShebangs --build node_modules"
    "bun --cwd=packages/agent-contracts run build"
    "bun --cwd=packages/codex run build"
    "bun --cwd=packages/otel run build"
    "bun --cwd=packages/temporal-bun-sdk run build"
    "bun --cwd=packages/cx-tools run build"
    "NODE_OPTIONS=--max-old-space-size=4096 CI=true JANGAR_BUILD_MINIFY=0 JANGAR_BUILD_SOURCEMAP=0 JANGAR_BUILD_LOG_LEVEL=warn bun --cwd=services/jangar run build"
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/packages" "$out/app/services/jangar"

    cp -R "$TMPDIR/work/node_modules" "$out/app/node_modules"

    for package in agent-contracts codex cx-tools design discord otel temporal-bun-sdk; do
      cp -R "$TMPDIR/work/packages/$package" "$out/app/packages/$package"
    done

    cp "$TMPDIR/work/services/jangar/package.json" "$out/app/services/jangar/package.json"
    cp -R "$TMPDIR/work/services/jangar/node_modules" "$out/app/services/jangar/node_modules"
    cp -R "$TMPDIR/work/services/jangar/.output" "$out/app/services/jangar/.output"
    mkdir -p "$out/app/services/jangar/src"
    cp -R "$TMPDIR/work/services/jangar/src/worker.ts" "$out/app/services/jangar/src/worker.ts"
    mkdir -p "$out/app/services/jangar/src/server"
    cp -R "$TMPDIR/work/services/jangar/src/server/runtime-entry-config.ts" "$out/app/services/jangar/src/server/runtime-entry-config.ts"
    cp -R "$TMPDIR/work/services/jangar/src/server/runtime-tooling-config.ts" "$out/app/services/jangar/src/server/runtime-tooling-config.ts"

    cp -R "$TMPDIR/work/services/bumba" "$out/app/services/bumba"
    rm -rf "$out/app/services/bumba/node_modules"
    ln -s /app/node_modules "$out/app/services/bumba/node_modules"

    chmod +x "$out/app/packages/cx-tools/dist/"*.js
  '';
  command = [
    "${pkgs.tini}/bin/tini"
    "--"
    "${entrypoint}/bin/jangar-entrypoint"
  ];
  workingDir = "/app/services/jangar";
  env = [
    "PORT=8080"
    "UI_PORT=8080"
    "WORKER_PORT=8070"
    "VSCODE_PORT=8081"
    "VSCODE_DATA_DIR=/workspace/.ovscode"
    "VSCODE_DEFAULT_FOLDER=/workspace/lab"
    "CODEX_CWD=/workspace/lab"
    "CODEX_REPO_SLUG=proompteng/lab"
    "CODEX_REPO_URL=https://github.com/proompteng/lab.git"
    "CODEX_BOOTSTRAP_REPO=1"
    "JANGAR_VERSION=${repoRevision}"
    "JANGAR_COMMIT=${repoRevision}"
    "JAVA_HOME=${pkgs.jdk25_headless}"
    "GRADLE_HOME=${pkgs.gradle_9}"
    "GOROOT=${pkgs.go}/share/go"
  ];
  extraContents = [
    codexCli
    entrypoint
    kubectl
    nodejs
    pkgs.bash
    pkgs.curl
    pkgs.docker-buildx
    pkgs.docker-client
    pkgs.gh
    pkgs.git
    pkgs.go
    pkgs.gradle_9
    pkgs.jdk25_headless
    pkgs.jq
    pkgs.kn
    pkgs.kubectl-cnpg
    pkgs.natscli
    pkgs.neovim
    pkgs.openssh
    pkgs.openvscode-server
    pkgs.python3
    pkgs.ripgrep
    pkgs.tmux
    pkgs.tini
    pkgs.unzip
    pkgs.uv
    pkgs.zoxide
  ] ++ cxTools;
  exposedPorts = {
    "8070/tcp" = { };
    "8080/tcp" = { };
    "8081/tcp" = { };
  };
  maxLayers = 32;
}
