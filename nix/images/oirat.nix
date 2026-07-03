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
    x86_64-linux = "sha256-dsUT1jkChBLckFmQpXjqUlRj6nVTRs0wXjpfNM3Nq4Q=";
    aarch64-linux = "sha256-sLwYDdj7SW6zt/F5jjNaH0BP7lKBR+AMueE3EvGFRso=";
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
