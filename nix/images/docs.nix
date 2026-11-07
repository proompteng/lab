{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "docs";
  packageName = "docs";
  depsHash = {
    x86_64-linux = "sha256-cg+1xbE0YDvY80hIotHTKxBrlDwGVagjivvU3dAwCEQ=";
    aarch64-linux = "sha256-kipWGrAAyiYr1VzfqJle6iddLgGM4xoC5YIO6q/5Xt4=";
  };
  dependencyClosure = "bunCache";
  installFilters = [
    "@proompteng/design"
    "docs"
  ];
  sourcePaths = [
    "apps/docs"
    "packages/design"
  ];
  buildCommands = [
    "bun --cwd=apps/docs run build"
  ];
  runtimeInstallPhase = ''
    cp -R "$TMPDIR/work/apps/docs/.next/standalone/." "$out/app/"
    mkdir -p "$out/app/apps/docs/.next/static" "$out/app/apps/docs/public"
    cp -R "$TMPDIR/work/apps/docs/.next/static/." "$out/app/apps/docs/.next/static/"
    if [ -d "$TMPDIR/work/apps/docs/public" ]; then
      cp -R "$TMPDIR/work/apps/docs/public/." "$out/app/apps/docs/public/"
    fi
  '';
  command = [
    "node"
    "server.js"
  ];
  workingDir = "/app/apps/docs";
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
