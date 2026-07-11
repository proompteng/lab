{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "proompteng";
  packageName = "landing";
  depsHash = {
    x86_64-linux = "sha256-geG7ZJtv27IdUGtlwevdOQBtjFUiNF5dSNEme+luEk8=";
    aarch64-linux = "sha256-oqp/RRislmnsry26/xJqg5ZQ45usjmaNcTzALTxQZtg=";
  };
  dependencyClosure = "bunCache";
  installFilters = [
    "@proompteng/backend"
    "@proompteng/design"
    "landing"
  ];
  sourcePaths = [
    "apps/landing"
    "packages/backend"
    "packages/design"
  ];
  buildCommands = [
    "bun --cwd=apps/landing run build"
  ];
  runtimeInstallPhase = ''
    cp -R "$TMPDIR/work/apps/landing/.next/standalone/." "$out/app/"
    mkdir -p "$out/app/apps/landing/.next/static" "$out/app/apps/landing/public"
    cp -R "$TMPDIR/work/apps/landing/.next/static/." "$out/app/apps/landing/.next/static/"
    if [ -d "$TMPDIR/work/apps/landing/public" ]; then
      cp -R "$TMPDIR/work/apps/landing/public/." "$out/app/apps/landing/public/"
    fi
  '';
  command = [
    "node"
    "server.js"
  ];
  workingDir = "/app/apps/landing";
  env = [
    "PORT=3000"
    "HOSTNAME=0.0.0.0"
  ];
  extraContents = [
    nodejs
  ];
  exposedPorts = {
    "3000/tcp" = { };
  };
}
