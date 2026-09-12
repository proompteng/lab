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
  # SHA-256 identity for bayn.intraday-momentum.behavior.v14, verified by the production executable.
  strategyBehaviorHash = "5981590560e7760e5525192f45be248b3b60b65b28e8c9c3b7b95d9f8e4d0e51";
  # Canonical hash of the compiled bayn.intraday-momentum.protocol.v3 document.
  strategyParameterHash = "ca956c6c35352d99705d94230c4fa47e3c7edbccd767d1572d5dbe531356436a";
  strategyName = "intraday-momentum";
  # Canonical bayn.strategy-protocol.v1 identity: name, behavior, parameters, and parameter schema.
  strategyProtocolHash = "474dd7cef2cad8c055d7fbf82301dda62f8d150004e508408da133bd8467aedc";
  # Canonical quote-bound policy for the build-contract account sentinel. It binds every source-controlled risk limit
  # without embedding a broker account identity; runtime separately verifies the account-bound activation policy.
  executionRiskPolicyHash = "2e60270036900493a121a87c73730960154278778a8aa71b663b138effd82227";
  forwardPerformanceCommand = pkgs.writeShellScriptBin "bayn-forward-performance" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/forward-performance-command.js" "$@"
  '';
  intradayReplayCommand = pkgs.writeShellScriptBin "bayn-intraday-replay" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/intraday-replay-command.js" "$@"
  '';
  vendorIntradayReplayCommand = pkgs.writeShellScriptBin "bayn-vendor-intraday-replay" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/vendor-intraday-replay-command.js" "$@"
  '';
  buildDefine = name: value: "--define ${name}=${lib.escapeShellArg (builtins.toJSON value)}";
  dependencySource = import ./bun-workspace-deps-source.nix { inherit lib repoRoot; };
  depsHash = {
    x86_64-linux = "sha256-RugImy5pe/8WfMsF5UjwHEwKjhsnwPtcskuE9D6XjDk=";
    aarch64-linux = "sha256-K8UEzB0sS4pllXEfWwigevTzUw91Rqm2fRU0GwPCyCU=";
  };
  buildCommands = [
    "bun --cwd=services/bayn run tsc"
    (
      "bun --cwd=services/bayn build src/index.ts src/verify-build-contract.ts src/forward-performance-command.ts src/intraday-replay-command.ts src/streaming-replay-command.ts src/streaming-diagnostics-command.ts src/vendor-intraday-replay-command.ts src/restate/restate-execution-server.ts src/restate/restate-execution-activate.ts --target=node "
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
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/intraday-replay-command.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/vendor-intraday-replay-command.js"
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
    cp "$TMPDIR/work/services/bayn/dist/intraday-replay-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/streaming-replay-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/streaming-diagnostics-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/vendor-intraday-replay-command.js" "$out/app/services/bayn/dist/"
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
  inherit pkgs lib bun nodejs depsHash runtimeRoot;
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
    intradayReplayCommand
    vendorIntradayReplayCommand
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
