{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

let
  codexCli = import ./openai-codex-cli.nix { inherit pkgs; };
in
import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "sag";
  packageName = "@proompteng/sag";
  depsHash = {
    x86_64-linux = "sha256-h1IJHQ/dQ9h9186ey5F9qvPciftsqs5C0Pzf20+VJcs=";
    aarch64-linux = "sha256-MKW2UdIImn3vKytf9R5IckUKfuTdjWchI2qSBv7Jh/Y=";
  };
  dependencyClosure = "bunCache";
  installFilters = [
    "@proompteng/codex"
    "@proompteng/sag"
  ];
  sourcePaths = [
    "packages/codex"
    "services/sag"
  ];
  buildCommands = [
    "bun --cwd=packages/codex run build"
    "bun run build:sag"
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/services/sag"
    cp -R "$TMPDIR/work/services/sag/.output" "$out/app/services/sag/.output"
    if [ -d "$TMPDIR/work/services/sag/public" ]; then
      cp -R "$TMPDIR/work/services/sag/public" "$out/app/services/sag/public"
    fi
    mkdir -p "$out/app/packages"
    cp -R "$TMPDIR/work/packages/codex" "$out/app/packages/codex"
    cp -R "$TMPDIR/work/node_modules" "$out/app/node_modules"
    if [ -d "$TMPDIR/work/services/sag/node_modules" ]; then
      cp -R "$TMPDIR/work/services/sag/node_modules" "$out/app/services/sag/node_modules"
    fi
    cp "$TMPDIR/work/services/sag/package.json" "$out/app/services/sag/package.json"
  '';
  command = [
    "bun"
    ".output/server/index.mjs"
  ];
  workingDir = "/app/services/sag";
  env = [
    "PORT=3000"
    "HOSTNAME=0.0.0.0"
    "NITRO_PORT=3000"
    "CODEX_HOME=/home/bun/.codex"
    "CODEX_AUTH=/home/bun/.codex/auth.json"
    "SAG_CODEX_BINARY=codex"
    "SAG_CODEX_CWD=/tmp"
  ];
  extraContents = [
    codexCli
    nodejs
    pkgs.bash
  ];
  exposedPorts = {
    "3000/tcp" = { };
  };
}
