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
    x86_64-linux = "sha256-Yqtge2t4S65wK01w2eWS1NTemKE/DtsGKBnbCvoJVts=";
    aarch64-linux = "sha256-+qTGlMa2G66FBXbnNfeN51KDgwIF7pt4Bn3JSAQSRxs=";
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
