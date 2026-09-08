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
    x86_64-linux = "sha256-TzGTUkDYeQs2e8IDZxJIcgoyPkvUfnqj6XAG1c2XDUA=";
    aarch64-linux = "sha256-Q6kYA6APOPWG+sWylkH+puauc9q2YxOXLGsOM8bQuqw=";
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
