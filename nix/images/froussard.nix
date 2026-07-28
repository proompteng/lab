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
    x86_64-linux = "sha256-0HkC0E6wnNY9cUsAgYC7pfrTxgAzTblLNl730QNbIHI=";
    aarch64-linux = "sha256-PzfUuI8vbOUedsg/aS7TE0AMlND/ojeDrhOiKrE9jIY=";
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
