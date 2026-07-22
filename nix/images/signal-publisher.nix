{
  pkgs,
  lib,
  repoRoot,
  repoRevision ? "dirty",
  bun,
  nodejs,
}:

let
  imageRepository = "registry.ide-newton.ts.net/lab/signal-publisher";
  buildDefine = name: value: "--define ${name}=${lib.escapeShellArg (builtins.toJSON value)}";
in
import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "signal-publisher";
  packageName = "@proompteng/signal-publisher";
  depsHash = {
    x86_64-linux = "sha256-ZShN/ISkl+4eSNeh7y7lsNpvNtTOhZtGgNIJH7iWD/c=";
    aarch64-linux = "sha256-P9PM81hh7EWEKJ4TkC2Yi7S4KAsanPWt4MAHlUWsK2w=";
  };
  installFilters = [
    "@proompteng/signal-publisher"
  ];
  sourcePaths = [
    "services/signal-publisher"
  ];
  buildCommands = [
    "bun --cwd=services/signal-publisher run tsc"
    (
      "bun --cwd=services/signal-publisher build src/main.ts --target=node --outdir=dist "
      + buildDefine "__SIGNAL_PUBLISHER_BUILD_SOURCE_REVISION__" repoRevision
      + " "
      + buildDefine "__SIGNAL_PUBLISHER_BUILD_IMAGE_REPOSITORY__" imageRepository
    )
    "grep -F -- ${lib.escapeShellArg repoRevision} services/signal-publisher/dist/main.js"
    (
      "bun services/signal-publisher/src/runtime-smoke.ts "
      + "services/signal-publisher/dist/main.js "
      + lib.escapeShellArg repoRevision
      + " "
      + lib.escapeShellArg imageRepository
    )
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/services/signal-publisher/dist"
    cp "$TMPDIR/work/services/signal-publisher/dist/main.js" \
      "$out/app/services/signal-publisher/dist/main.js"
  '';
  command = [
    "node"
    "dist/main.js"
  ];
  workingDir = "/app/services/signal-publisher";
  includeBunRuntime = false;
  extraContents = [
    nodejs
  ];
  labels = {
    "org.opencontainers.image.revision" = repoRevision;
  };
}
