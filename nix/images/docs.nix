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
    x86_64-linux = "sha256-P879z1I/8CVitBZsm94MndNn9BDXsOEOJy6fbJ13/YY=";
    aarch64-linux = "sha256-0bnYXdvOszbzzYzsZctRxeW/VEVxoJbWlO2tHKy5s5M=";
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
