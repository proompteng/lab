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
    x86_64-linux = "sha256-UVf3WOodJj9RCl3H0rGTpo1EOOekzcPN288y3DJ08c0=";
    aarch64-linux = "sha256-fkdC7RAPgQME79kor3txmeFTXwtmCKGS0nPkDTH1I40=";
  };
  installFilters = [
    "@proompteng/agent-contracts"
    "@proompteng/bumba"
    "@proompteng/temporal-bun-sdk"
  ];
  sourcePaths = [
    "packages/agent-contracts"
    "packages/temporal-bun-sdk"
    "services/bumba"
  ];
  buildCommands = [
    "bun --cwd=packages/agent-contracts run build"
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
