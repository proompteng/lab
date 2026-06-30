{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "app";
  packageName = "app";
  depsHash = {
    x86_64-linux = "sha256-6vJYwq3eMU0JQEQMoaUgXwZV+V77rovjN0QNL7brCDE=";
    aarch64-linux = "sha256-PQUIJ9RmRoi2n3GAO0OnWBAPOgyLJRUZoJQmw27KSNY=";
  };
  installFilters = [
    "@proompteng/design"
    "app"
  ];
  sourcePaths = [
    "apps/app"
    "packages/design"
  ];
  buildCommands = [
    "bun --cwd=apps/app run build"
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/apps/app"
    cp -R "$TMPDIR/work/apps/app/.output" "$out/app/apps/app/.output"
    if [ -d "$TMPDIR/work/apps/app/public" ]; then
      cp -R "$TMPDIR/work/apps/app/public" "$out/app/apps/app/public"
    fi
    cp -R "$TMPDIR/work/node_modules" "$out/app/node_modules"
    if [ -d "$TMPDIR/work/apps/app/node_modules" ]; then
      cp -R "$TMPDIR/work/apps/app/node_modules" "$out/app/apps/app/node_modules"
    fi
    cp "$TMPDIR/work/apps/app/package.json" "$out/app/apps/app/package.json"
  '';
  command = [
    "node"
    ".output/server/index.mjs"
  ];
  workingDir = "/app/apps/app";
  env = [
    "PORT=3000"
    "HOSTNAME=0.0.0.0"
    "NITRO_PORT=3000"
  ];
  extraContents = [
    nodejs
  ];
  exposedPorts = {
    "3000/tcp" = { };
  };
}
