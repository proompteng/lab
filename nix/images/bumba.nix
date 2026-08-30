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
    x86_64-linux = "sha256-fQPmz98gL7/A3RDVxy0jEj6HIEBGyazpAq5+1Z0O3f0=";
    aarch64-linux = "sha256-jxzFqX186XH1RfkkAhEVA5Rxlcrd07h/s0T96pNdsig=";
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
    "tini"
    "-g"
    "--"
    "bun"
    "services/bumba/src/worker.ts"
  ];
  extraContents = [
    pkgs.git
    pkgs.tini
  ];
  exposedPorts = {
    "3001/tcp" = { };
  };
}
