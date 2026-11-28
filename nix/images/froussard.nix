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
    x86_64-linux = "sha256-3oPKDecD6i+9Fvru+ZL4ScHhYrgu1+uUlpNnY0bMTB8=";
    aarch64-linux = "sha256-8qdMrmwj7g1BJZunEzyjMfGcLXwUYrqLDpTDB6UZE9M=";
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
