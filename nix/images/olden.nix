{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "olden";
  packageName = "olden";
  depsHash = {
    x86_64-linux = "sha256-vc4SG35iiMgmunllrGLQwOucM/cnar+8wsNyJpumuog=";
    aarch64-linux = "sha256-50VuVS39bpoVVVDj0iYYzKfxMo9cCcuGdIdPtjWThVI=";
  };
  dependencyClosure = "bunCache";
  installFilters = [
    "@proompteng/design"
    "olden"
  ];
  sourcePaths = [
    "apps/olden"
    "packages/design"
  ];
  buildCommands = [
    "bun --cwd=apps/olden run build"
  ];
  runtimeInstallPhase = ''
    cp -R "$TMPDIR/work/apps/olden/.next/standalone/." "$out/app/"
    mkdir -p "$out/app/apps/olden/.next/static" "$out/app/apps/olden/public"
    cp -R "$TMPDIR/work/apps/olden/.next/static/." "$out/app/apps/olden/.next/static/"
    if [ -d "$TMPDIR/work/apps/olden/public" ]; then
      cp -R "$TMPDIR/work/apps/olden/public/." "$out/app/apps/olden/public/"
    fi
  '';
  command = [
    "node"
    "server.js"
  ];
  workingDir = "/app/apps/olden";
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
