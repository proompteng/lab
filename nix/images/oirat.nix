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
    x86_64-linux = "sha256-RH7kBMe1mCaAvkyA2TQdKinIpheGY7Ylfg22UOAou2M=";
    aarch64-linux = "sha256-Re0aJXH/pVzJSvFUATVAtXHw2lIWi+GYc6ckbN5ShKY=";
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
