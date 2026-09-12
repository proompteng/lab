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
    x86_64-linux = "sha256-/tBlm+xfp+2LiPpahEKwg+MJAxp7Xtba5OZn4vqX76g=";
    aarch64-linux = "sha256-r8bqBwSinC2px5vaRRKwm0WelKeojZZSdXKURS25eek=";
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
