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
  # SHA-256 identity for bayn.jev.behavior.v3, verified by the production executable.
  strategyBehaviorHash = "a63b43489d8d386319e0816157766da9225ced9482cef51f547beb6cee3254c0";
  # Canonical hash of the compiled bayn.jev.protocol.v1 document.
  strategyParameterHash = "86a3015dca27e514c7d3f53ecb27d3648e7fce1ea0c2e25325df6bbff83524bd";
  strategyName = "jev";
  # Canonical bayn.strategy-protocol.v1 identity: name, behavior, parameters, and parameter schema.
  strategyProtocolHash = "131371357a091ac5d09f5a3dd1585b84cb5509e334beef99ee9d5f14600cf908";
  # Canonical quote-bound policy for the build-contract account sentinel. It binds every source-controlled risk limit
  # without embedding a broker account identity; runtime separately verifies the account-bound activation policy.
  executionRiskPolicyHash = "2e60270036900493a121a87c73730960154278778a8aa71b663b138effd82227";
  forwardPerformanceCommand = pkgs.writeShellScriptBin "bayn-forward-performance" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/forward-performance-command.js" "$@"
  '';
  backtestCommand = pkgs.writeShellScriptBin "bayn-backtest" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/backtest-command.js" "$@"
  '';
  buildDefine = name: value: "--define ${name}=${lib.escapeShellArg (builtins.toJSON value)}";
  dependencySource = import ./bun-workspace-deps-source.nix { inherit lib repoRoot; };
  depsHash = {
    x86_64-linux = "sha256-E1eWfKcndCEpFyIJU1jKPcsUQhUk2e5rpvCOPYBmg4Q=";
    aarch64-linux = "sha256-AhXhmEx068otyjCOW67RUO87wpuZknsyHuNgedo0Tp8=";
  };
  buildCommands = [
    "bun --cwd=services/bayn run tsc"
    (
      "bun --cwd=services/bayn build src/index.ts src/verify-build-contract.ts src/forward-performance-command.ts src/backtest-command.ts src/streaming-diagnostics-command.ts src/restate/restate-execution-server.ts src/restate/restate-execution-activate.ts --target=node "
      + "--external tigerbeetle-node --external @platformatic/kafka --entry-naming '[name].js' --outdir=dist "
      + buildDefine "__BAYN_BUILD_SOURCE_REVISION__" repoRevision
      + " "
      + buildDefine "__BAYN_BUILD_IMAGE_REPOSITORY__" imageRepository
      + " "
      + buildDefine "__BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__" strategyBehaviorHash
      + " "
      + buildDefine "__BAYN_BUILD_STRATEGY_PARAMETER_HASH__" strategyParameterHash
      + " "
      + buildDefine "__BAYN_BUILD_STRATEGY_NAME__" strategyName
      + " "
      + buildDefine "__BAYN_BUILD_STRATEGY_PROTOCOL_HASH__" strategyProtocolHash
      + " "
      + buildDefine "__BAYN_BUILD_EXECUTION_RISK_POLICY_HASH__" executionRiskPolicyHash
    )
    "node services/bayn/dist/verify-build-contract.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/forward-performance-command.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/backtest-command.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/restate-execution-server.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/restate-execution-activate.js"
    "grep -F -- ${lib.escapeShellArg strategyBehaviorHash} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg strategyParameterHash} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg strategyName} services/bayn/dist/verify-build-contract.js"
    "grep -F -- ${lib.escapeShellArg strategyProtocolHash} services/bayn/dist/verify-build-contract.js"
    "grep -F -- ${lib.escapeShellArg executionRiskPolicyHash} services/bayn/dist/verify-build-contract.js"
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/services/bayn/dist"
    cp "$TMPDIR/work/services/bayn/dist/index.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/forward-performance-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/backtest-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/streaming-diagnostics-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/restate-execution-server.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/restate-execution-activate.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/package.json" "$out/app/services/bayn/package.json"
    node "$TMPDIR/work/services/bayn/scripts/copy-runtime-dependencies.mjs" \
      "$TMPDIR/work/services/bayn" "$out/app/services/bayn"
  '';
  runtimeRoot = import ./bayn-runtime-root.nix {
    inherit
      pkgs
      lib
      repoRoot
      dependencySource
      depsHash
      bun
      nodejs
      buildCommands
      runtimeInstallPhase
      ;
  };
in
import ./bun-workspace-service.nix {
  inherit
    pkgs
    lib
    bun
    nodejs
    depsHash
    runtimeRoot
    ;
  repoRoot = dependencySource;
  serviceName = "bayn";
  packageName = "@proompteng/bayn";
  # Bayn's fixed-output dependency closure is intentionally isolated from TypeScript source-tree topology.
  # Refreshed once after dependencySource became a manifest/lock/patch-only file set. Source-only tree changes
  # can no longer perturb these architecture-specific dependency outputs.
  installFilters = [
    "@proompteng/bayn"
  ];
  sourcePaths = [ ];
  command = [
    "node"
    "dist/index.js"
  ];
  workingDir = "/app/services/bayn";
  includeBunRuntime = false;
  extraContents = [
    nodejs
    pkgs.cacert
    forwardPerformanceCommand
    backtestCommand
  ];
  exposedPorts = {
    "8080/tcp" = { };
    "9080/tcp" = { };
  };
  labels = {
    "org.opencontainers.image.revision" = repoRevision;
    "proompteng.ai/bayn.strategy-behavior-hash" = strategyBehaviorHash;
    "proompteng.ai/bayn.strategy-parameter-hash" = strategyParameterHash;
    "proompteng.ai/bayn.strategy-name" = strategyName;
    "proompteng.ai/bayn.strategy-protocol-hash" = strategyProtocolHash;
    "proompteng.ai/bayn.execution-risk-policy-hash" = executionRiskPolicyHash;
  };
}
