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
    x86_64-linux = "sha256-NJAggio+kMUI4CkQyuiDII6ajRaUltyHquFKcOQvcgo=";
    aarch64-linux = "sha256-jyd9hcARS6u/vIJi+cxtC0yFEcmqX4fQHmIQod8aeaw=";
  };
  installFilters = [
    "@proompteng/bumba"
    "@proompteng/temporal-bun-sdk"
  ];
  sourcePaths = [
    "packages/temporal-bun-sdk"
    "services/bumba"
  ];
  buildCommands = [
    "bun --cwd=packages/temporal-bun-sdk run build"
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
