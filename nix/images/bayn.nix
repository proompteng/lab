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
  # Immutable identity for bayn.risk-balanced-trend.behavior.v1. The deterministic evaluator and decision fingerprints
  # are locked in risk-balanced-trend.test.ts, so behavior-preserving refactors retain the same identity.
  strategyBehaviorHash = "43cece33d3db232ffb02ba78826727e50b5795319d09d27e1baa0c04709eb056";
  # Canonical hash of the compiled bayn.risk-balanced-trend.protocol.v2 document.
  strategyParameterHash = "cf639d3692da65271b12423f9b7c6c9663e1fb13ae7290dc56fcfa3acf16eb69";
  buildDefine = name: value: "--define ${name}=${lib.escapeShellArg (builtins.toJSON value)}";
in
import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "bayn";
  packageName = "@proompteng/bayn";
  depsHash = {
    x86_64-linux = "sha256-HOivxpn3uqVZlCG3XM/zeh9sg7yNXUzh1nHcLpNsBmA=";
    aarch64-linux = "sha256-d5QZaVMgc+DgKfwaoiXKulU/iBV8VVBbhEQWdXd6dzk=";
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
      "bun --cwd=services/bayn build src/index.ts src/verify-build-contract.ts --target=node "
      + "--external tigerbeetle-node --outdir=dist "
      + buildDefine "__BAYN_BUILD_SOURCE_REVISION__" repoRevision
      + " "
      + buildDefine "__BAYN_BUILD_IMAGE_REPOSITORY__" imageRepository
      + " "
      + buildDefine "__BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__" strategyBehaviorHash
      + " "
      + buildDefine "__BAYN_BUILD_STRATEGY_PARAMETER_HASH__" strategyParameterHash
    )
    "node services/bayn/dist/verify-build-contract.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg strategyBehaviorHash} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg strategyParameterHash} services/bayn/dist/index.js"
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/services/bayn/dist" "$out/app/services/bayn/node_modules/tigerbeetle-node"
    cp "$TMPDIR/work/services/bayn/dist/index.js" "$out/app/services/bayn/dist/"
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
    "proompteng.ai/bayn.strategy-parameter-hash" = strategyParameterHash;
  };
}
