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
    x86_64-linux = "sha256-lcV9GuSRajZ3dYeQLR8EU4k0hqx5YpMKuCRy/EBOf+k=";
    aarch64-linux = "sha256-YJVzJHUvH30ecB0RQWjS4+qy/7Clcf81gndkEIb/eT8=";
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
