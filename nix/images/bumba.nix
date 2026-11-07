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
    x86_64-linux = "sha256-BAgU1eglduUUA2bh7Z6JE7+GmajKGqsr+MrqGF2vkWw=";
    aarch64-linux = "sha256-jZEqquUfafiSS016SvXLh1VaNKtQBBdGzt6LXdKKqms=";
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
