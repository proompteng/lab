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
    x86_64-linux = "sha256-uY0V6XA1MVn8XEUN8cA85c1L5fPvW5Zs1rJwr80jRCA=";
    aarch64-linux = "sha256-fkdC7RAPgQME79kor3txmeFTXwtmCKGS0nPkDTH1I40=";
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
