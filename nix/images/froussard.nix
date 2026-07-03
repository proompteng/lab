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
    x86_64-linux = "sha256-Ctm7jVWwS7aFROoHrwOb0r4vwilTWqpxo8z5+zdmSJU=";
    aarch64-linux = "sha256-ko0nDKmqJdnsZNHVjU01sO8FBoZhwAtPx4XKqYGG3DE=";
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
