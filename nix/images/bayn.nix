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
  strategyBehaviorFiles = [
    {
      name = "services/bayn/src/contracts.ts";
      path = ../../services/bayn/src/contracts.ts;
    }
    {
      name = "services/bayn/src/execution-model.ts";
      path = ../../services/bayn/src/execution-model.ts;
    }
    {
      name = "services/bayn/src/hash.ts";
      path = ../../services/bayn/src/hash.ts;
    }
    {
      name = "services/bayn/src/index.ts";
      path = ../../services/bayn/src/index.ts;
    }
    {
      name = "services/bayn/src/ledger.ts";
      path = ../../services/bayn/src/ledger.ts;
    }
    {
      name = "services/bayn/src/market-data.ts";
      path = ../../services/bayn/src/market-data.ts;
    }
    {
      name = "services/bayn/src/protocol.ts";
      path = ../../services/bayn/src/protocol.ts;
    }
    {
      name = "services/bayn/src/qualification-statistics.ts";
      path = ../../services/bayn/src/qualification-statistics.ts;
    }
    {
      name = "services/bayn/src/qualification.ts";
      path = ../../services/bayn/src/qualification.ts;
    }
    {
      name = "services/bayn/src/risk-balanced-trend.ts";
      path = ../../services/bayn/src/risk-balanced-trend.ts;
    }
    {
      name = "services/bayn/src/simulation-reconciliation.ts";
      path = ../../services/bayn/src/simulation-reconciliation.ts;
    }
    {
      name = "services/bayn/src/simulation.ts";
      path = ../../services/bayn/src/simulation.ts;
    }
    {
      name = "services/bayn/src/strategy.ts";
      path = ../../services/bayn/src/strategy.ts;
    }
    {
      name = "services/bayn/src/strategy-service.ts";
      path = ../../services/bayn/src/strategy-service.ts;
    }
    {
      name = "services/bayn/src/types.ts";
      path = ../../services/bayn/src/types.ts;
    }
  ];
  strategyBehaviorHash = builtins.hashString "sha256" (
    builtins.concatStringsSep "\n" (
      builtins.map (source: source.name + "\n" + builtins.readFile source.path) strategyBehaviorFiles
    )
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
