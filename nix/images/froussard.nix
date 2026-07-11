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
    x86_64-linux = "sha256-21YVEeBdNggoDr53RT9gjRJEVjrYNL06vB7k07hyx10=";
    aarch64-linux = "sha256-fmFLCik0rMBdyLXL70aPUTcobPPb5pMnWVA2y5n9ur4=";
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
