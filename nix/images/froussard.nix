{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "froussard";
  packageName = "froussard";
  depsHash = {
    x86_64-linux = "sha256-26/6Ammo5anJCXBKZ4oPP89Vd/7S9QKej468Ddo2WoU=";
    aarch64-linux = "sha256-zs6OZIdEVME3IySyksc4iU/CNLdD50yyOqVtPsocYNU=";
  };
  installFilters = [
    "@proompteng/agent-contracts"
    "froussard"
  ];
  sourcePaths = [
    "apps/froussard"
    "packages/agent-contracts"
  ];
  buildCommands = [
    "bun --cwd=packages/agent-contracts run build"
    "bun --cwd=apps/froussard run build"
  ];
  command = [
    "bun"
    "dist/index.mjs"
  ];
  workingDir = "/app/apps/froussard";
  exposedPorts = {
    "8080/tcp" = { };
  };
}
