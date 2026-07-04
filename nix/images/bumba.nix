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
  depsHash = {
    x86_64-linux = "sha256-r1MqBWNeGieUQque+vdJCPDGxMx3gOTmPOuTnzRQ+Pc=";
    aarch64-linux = "sha256-r1MqBWNeGieUQque+vdJCPDGxMx3gOTmPOuTnzRQ+Pc=";
  };
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
