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
    x86_64-linux = "sha256-zU6F/cG9/KbQmEn3XfNQ/j2rUUqGWRn7LIuVnW2GM50=";
    aarch64-linux = "sha256-MYvTE3Gp+/B8tUeyKYFcyXfQYSIJ55ScJah+SP29REY=";
  };
  dependencyClosure = "bunCache";
  installFilters = [
    "@proompteng/source"
    "@proompteng/backend"
    "@proompteng/design"
    "landing"
  ];
  sourcePaths = [
    "apps/landing"
    "packages/backend"
    "packages/design"
    "services/tengri/proto"
  ];
  buildCommands = [
    "bun --cwd=apps/landing run prebuild"
    "(cd apps/landing && node node_modules/next/dist/bin/next build --webpack)"
  ];
  runtimeInstallPhase = ''
    cp -R "$TMPDIR/work/apps/landing/.next/standalone/." "$out/app/"
    mkdir -p "$out/app/apps/landing/.next/static" "$out/app/apps/landing/public"
    cp -R "$TMPDIR/work/apps/landing/.next/static/." "$out/app/apps/landing/.next/static/"
    if [ -d "$TMPDIR/work/apps/landing/public" ]; then
      cp -R "$TMPDIR/work/apps/landing/public/." "$out/app/apps/landing/public/"
    fi
    mkdir -p "$out/app/services/tengri/proto"
    cp -R "$TMPDIR/work/services/tengri/proto/." "$out/app/services/tengri/proto/"
  '';
  command = [
    "node"
    "server.js"
  ];
  workingDir = "/app/apps/landing";
  env = [
    "PORT=3000"
    "HOSTNAME=0.0.0.0"
    "TENGRI_PROTO_PATH=/app/services/tengri/proto/proompteng/runtime/v1/microvm.proto"
  ];
  extraContents = [
    nodejs
  ];
  exposedPorts = {
    "3000/tcp" = { };
  };
}
