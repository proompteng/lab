{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
  repoRevision,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "bumba";
  packageName = "@proompteng/bumba";
  depsHash = "sha256-H4lK2btS85onVqnGLIjpeM/hU/D5DGMlVPGdaS/GSUc=";
  installFilters = [
    "@proompteng/bumba"
    "@proompteng/temporal-bun-sdk"
  ];
  sourcePaths = [
    "packages/temporal-bun-sdk"
    "services/bumba"
  ];
  buildCommands = [
    "bun --cwd=packages/temporal-bun-sdk run build"
  ];
  command = [
    "bun"
    "services/bumba/src/worker.ts"
  ];
  env = [
    "TEMPORAL_WORKER_BUILD_ID=bumba@${repoRevision}"
  ];
  extraContents = [
    pkgs.git
  ];
  exposedPorts = {
    "3001/tcp" = { };
  };
}
