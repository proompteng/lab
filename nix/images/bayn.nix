{
  pkgs,
  lib,
  repoRoot,
  repoRevision ? "dirty",
  bun,
  nodejs,
}:

let
  imageRepository = "registry.ide-newton.ts.net/lab/bayn";
  strategyBehaviorHash = builtins.hashString "sha256" (
    "services/bayn/src/hash.ts\n"
    + builtins.readFile ../../services/bayn/src/hash.ts
    + "\nservices/bayn/src/execution-model.ts\n"
    + builtins.readFile ../../services/bayn/src/execution-model.ts
    + "\nservices/bayn/src/strategy.ts\n"
    + builtins.readFile ../../services/bayn/src/strategy.ts
  );
  buildDefine = name: value: "--define ${name}=${lib.escapeShellArg (builtins.toJSON value)}";
in
import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "bayn";
  packageName = "@proompteng/bayn";
  depsHash = {
    x86_64-linux = "sha256-PIrg1j+HNm1PUD9OHHdPYaVu2xdJ9SohAFxHsxSf9iM=";
    aarch64-linux = "sha256-PwP+ISp9QUubnxee0JdDntGBpIUquiBXZXNTa29D8O0=";
  };
  installFilters = [
    "@proompteng/bayn"
  ];
  sourcePaths = [
    "services/bayn"
  ];
  buildCommands = [
    "bun --cwd=services/bayn run tsc"
    (
      "bun --cwd=services/bayn build src/index.ts --target=node "
      + "--external tigerbeetle-node --outdir=dist "
      + buildDefine "__BAYN_BUILD_SOURCE_REVISION__" repoRevision
      + " "
      + buildDefine "__BAYN_BUILD_IMAGE_REPOSITORY__" imageRepository
      + " "
      + buildDefine "__BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__" strategyBehaviorHash
    )
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg strategyBehaviorHash} services/bayn/dist/index.js"
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/services/bayn/dist" "$out/app/services/bayn/node_modules/tigerbeetle-node"
    cp "$TMPDIR/work/services/bayn/dist/index.js" "$out/app/services/bayn/dist/index.js"
    cp "$TMPDIR/work/services/bayn/package.json" "$out/app/services/bayn/package.json"
    cp -R -L "$TMPDIR/work/services/bayn/node_modules/tigerbeetle-node/." \
      "$out/app/services/bayn/node_modules/tigerbeetle-node/"
  '';
  command = [
    "node"
    "dist/index.js"
  ];
  workingDir = "/app/services/bayn";
  includeBunRuntime = false;
  extraContents = [
    nodejs
  ];
  exposedPorts = {
    "8080/tcp" = { };
  };
  labels = {
    "org.opencontainers.image.revision" = repoRevision;
    "proompteng.ai/bayn.strategy-behavior-hash" = strategyBehaviorHash;
  };
}
