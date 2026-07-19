{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "bayn";
  packageName = "@proompteng/bayn";
  depsHash = lib.fakeHash;
  installFilters = [
    "@proompteng/bayn"
  ];
  sourcePaths = [
    "services/bayn"
  ];
  buildCommands = [
    "bun --cwd=services/bayn run tsc"
    "bun --cwd=services/bayn run build"
  ];
  command = [
    "node"
    "dist/index.js"
  ];
  workingDir = "/app/services/bayn";
  extraContents = [
    nodejs
  ];
  exposedPorts = {
    "8080/tcp" = { };
  };
}
