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
    x86_64-linux = "sha256-sQoweSUF9OxBXPLU9c7Jhvqay1GrF202JfWkTnTn6G4=";
    aarch64-linux = "sha256-sQoweSUF9OxBXPLU9c7Jhvqay1GrF202JfWkTnTn6G4=";
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
