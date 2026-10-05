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
    # Draft discovery only. Replace both native hashes before review and merge.
    x86_64-linux = lib.fakeHash;
    aarch64-linux = lib.fakeHash;
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
