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
    x86_64-linux = "sha256-W4RToWAToEM/Jfsl1Dmbi6Cp5xV4Ye3WZshj8j5BFwE=";
    aarch64-linux = "sha256-UUFnfC8AkxWsW3I67Wpn7AmU+US7rfvspFVizbBOl24=";
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
