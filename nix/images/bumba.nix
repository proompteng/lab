{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "bumba";
  packageName = "@proompteng/bumba";
  depsHash = {
    x86_64-linux = "sha256-R/H9X//JXksoAM4jm7aNDeSNhgrt5GUI99IDgG6Ama4=";
    aarch64-linux = "sha256-gojR9ee04L/POEAMzccKbgGjOTtZQgcMXPTVgjWTSvk=";
  };
  installFilters = [
    "@proompteng/bumba"
  ];
  sourcePaths = [
    "services/bumba"
  ];
  buildCommands = [
    "bun services/bumba/scripts/verify-temporal-runtime.ts services/bumba"
  ];
  runtimeInstallPhase = ''
    cp -R "$TMPDIR/work/." "$out/app/"
    bun "$out/app/services/bumba/scripts/verify-temporal-runtime.ts" "$out/app/services/bumba"
  '';
  command = [
    "tini"
    "-g"
    "--"
    "bun"
    "services/bumba/src/worker.ts"
  ];
  extraContents = [
    pkgs.git
    pkgs.tini
  ];
  exposedPorts = {
    "3001/tcp" = { };
  };
}
