{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

let
  dependencySource = import ./bun-workspace-deps-source.nix { inherit lib repoRoot; };
in
import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  inherit dependencySource;
  serviceName = "oirat";
  packageName = "@proompteng/oirat";
  depsHash = {
    x86_64-linux = "sha256-oVrmJyE7t/gvkyL0TEUENIp/TWMZUTnfR3AjtJ9kkN8=";
    aarch64-linux = "sha256-QneVc/nEZ4r/WTCO55qLxp562CdWxnP8EicL87aIeD0=";
  };
  installFilters = [
    "@proompteng/discord"
    "@proompteng/oirat"
  ];
  sourcePaths = [
    "packages/discord"
    "services/oirat"
  ];
  buildCommands = [
    "bun --cwd=packages/discord run build"
  ];
  command = [
    "bun"
    "services/oirat/src/index.ts"
  ];
}
