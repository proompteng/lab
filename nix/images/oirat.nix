{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "oirat";
  packageName = "@proompteng/oirat";
  depsHash = {
    x86_64-linux = "sha256-s3ztqU4KpawM0YU2dH8uD7vMM2B3smIhQuiE8eWlrII=";
    aarch64-linux = "sha256-U0gjHUvVc8mjJ9GqL0LthTOo+gOTqX7ym82LpRY3Ftg=";
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
