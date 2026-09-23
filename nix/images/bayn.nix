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
  # SHA-256 identity for bayn.jev.behavior.v1, verified by the production executable.
  strategyBehaviorHash = "ecf38828f63b2ac6171dd0e4ae3ac16b5b918ace69374ead176ea9d6c1bf4390";
  # Canonical hash of the compiled bayn.jev.protocol.v1 document.
  strategyParameterHash = "a75bb665c325a3c905e3e95246da279fd4314eb00009f3caef842ab015b056f1";
  strategyName = "jev";
  # Canonical bayn.strategy-protocol.v1 identity: name, behavior, parameters, and parameter schema.
  strategyProtocolHash = "628d8354ed9f4ae6152a5ca03078c761fca53598bfb581d647035bc5a4edf12a";
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
    x86_64-linux = "sha256-6QtJftiUs06mYWX4uXq/6owrkFL2HzBZpal2fQt8lKo=";
    aarch64-linux = "sha256-OtS04OMVTmP4Llnm9tOYlz3Ngen8rzfFMo4GWCUbyjU=";
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
