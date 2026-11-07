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
    x86_64-linux = "sha256-CWpLCsKqo/SXfF50bZa7/JXIOOSrj8VuPFxYZra3JQ4=";
    aarch64-linux = "sha256-fk4x/j0C1bWXHtRSAZBkNIqE3ZZEcBdsUt+mRTed/+k=";
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
