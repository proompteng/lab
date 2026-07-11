{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "bumba";
  packageName = "@proompteng/bumba";
  depsHash = {
    x86_64-linux = "sha256-OyGhoRH+YX4/sBagr0nu7yaoGvQYhRQyyHeyRIU3vlY=";
    aarch64-linux = "sha256-OyGhoRH+YX4/sBagr0nu7yaoGvQYhRQyyHeyRIU3vlY=";
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
  extraContents = [
    pkgs.git
  ];
  exposedPorts = {
    "3001/tcp" = { };
  };
}
