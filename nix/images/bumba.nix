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
    x86_64-linux = "sha256-uaD+K8XPYZwSimZQ7dA9oI6Tu+sZynbFsOqVdIF7Ik8=";
    aarch64-linux = "sha256-5IdrszOVNJml6CzXw1zOsDGbwhvbp4X475N4camklh0=";
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
