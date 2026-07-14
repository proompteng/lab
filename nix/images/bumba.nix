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
    x86_64-linux = "sha256-1/wV3iFBqYwcQ0PeRvjIQ18nzTXUr0qSSNtBoAOp4B0=";
    aarch64-linux = "sha256-yTCJnzAHvsV9P++1xQbem0AOeTlAyeDT3Oke+hBl+O8=";
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
