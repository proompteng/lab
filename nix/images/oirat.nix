{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "oirat";
  packageName = "@proompteng/oirat";
  depsHash = {
    x86_64-linux = "sha256-HlcpG+m5TFAbu1Aa+N/BOzPSERhSPQxxJv3VyL51mvQ=";
    aarch64-linux = "sha256-Kac9lgXk/JrNiWy7tHmMF8kq5yIMXE99UYR9szhbLxc=";
  };
  installFilters = [
    "@proompteng/discord"
    "@proompteng/oirat"
  ];
  sourcePaths = [
    "packages/discord"
    "services/oirat"
  ];
  buildCommands = [
    "bun --cwd=packages/discord run build"
  ];
  command = [
    "bun"
    "services/oirat/src/index.ts"
  ];
}
