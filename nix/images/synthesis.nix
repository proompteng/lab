{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "synthesis";
  packageName = "synthesis";
  depsHash = {
    x86_64-linux = "sha256-dG/J1KuH5cvF1e3obc4+yuJfl+Jt6BeuzkBC2ln5hME=";
    aarch64-linux = "sha256-PJl3Of83HoN4Sp2if9zhAJHx33KR/0Iq9ylMjecDYwk=";
  };
  dependencyClosure = "bunCache";
  installFilters = [
    "@proompteng/design"
    "synthesis"
  ];
  sourcePaths = [
    "apps/synthesis"
    "packages/design"
  ];
  buildCommands = [
    "bun --cwd=apps/synthesis run build"
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/apps/synthesis"
    cp -R "$TMPDIR/work/apps/synthesis/.output" "$out/app/apps/synthesis/.output"
    if [ -d "$TMPDIR/work/apps/synthesis/public" ]; then
      cp -R "$TMPDIR/work/apps/synthesis/public" "$out/app/apps/synthesis/public"
    fi
    mkdir -p "$out/app/packages"
    cp -R "$TMPDIR/work/packages/design" "$out/app/packages/design"
    cp -R "$TMPDIR/work/node_modules" "$out/app/node_modules"
    if [ -d "$TMPDIR/work/apps/synthesis/node_modules" ]; then
      cp -R "$TMPDIR/work/apps/synthesis/node_modules" "$out/app/apps/synthesis/node_modules"
    fi
    cp "$TMPDIR/work/apps/synthesis/package.json" "$out/app/apps/synthesis/package.json"
  '';
  command = [
    "node"
    ".output/server/index.mjs"
  ];
  workingDir = "/app/apps/synthesis";
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
