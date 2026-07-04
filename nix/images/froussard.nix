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
    x86_64-linux = "sha256-kJ3EYa/VBjZdlSwCYq/7suUohBFxxoghZoDalfTOiY8=";
    aarch64-linux = "sha256-ft1Zcx/6ocKrRQbUs15r0d2Vu2aA7+leb6N7Qd/V28g=";
  };
  installFilters = [
    "@proompteng/agent-contracts"
    "@proompteng/codex"
    "@proompteng/discord"
    "@proompteng/otel"
    "froussard"
  ];
  sourcePaths = [
    "apps/froussard"
    "packages/agent-contracts"
    "packages/codex"
    "packages/discord"
    "packages/otel"
  ];
  buildCommands = [
    "bun --cwd=packages/agent-contracts run build"
    "bun --cwd=packages/otel run build"
    "bun --cwd=packages/discord run build"
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
