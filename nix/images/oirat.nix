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
    x86_64-linux = "sha256-ppri6585oqRrfqIQRN6OVl7vWWh7rgpfJ4TroYtdizk=";
    aarch64-linux = "sha256-xBaUA5oRO1LGRbBj5k/2lyGnTynyBhelu1Oxuh/cqoU=";
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
