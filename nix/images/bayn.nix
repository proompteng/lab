{
  pkgs,
  lib,
  repoRoot,
  repoRevision ? "dirty",
  bun,
  nodejs,
  research ? false,
}:

let
  frozenControl = import ./bayn-frozen-control.nix { inherit pkgs lib bun nodejs; };
  imageName = if research then "bayn-research" else "bayn";
  imageRepository = "registry.ide-newton.ts.net/lab/${imageName}";
  runtimeEntrypoints = if research then [
    "src/restate/restate-research-server.ts"
    "src/inference-cost-command.ts"
    "src/forward-performance-command.ts"
    "src/forward-performance-verification-worker.ts"
    "src/system-assessment-command.ts"
    "src/research-command.ts"
    "src/jev-evaluation-command.ts"
    "src/native-arrival-export-command.ts"
    "src/jev-study-export-command.ts"
    "src/webull-research-command.ts"
    "tools/equity-edge-screen.ts"
    "tools/run-macro-etf-core-rebalance.ts"
    "tools/run-macro-canary-etf-rebalance.ts"
    "tools/bayn-daily-scorecard.ts"
  ] else [
    "src/decision-construction-worker.ts"
    "src/index.ts"
    "src/forward-performance-command.ts"
    "src/forward-performance-verification-worker.ts"
    "src/control-opening-command.ts"
    "src/restate/restate-execution-server.ts"
    "src/restate/restate-execution-activate.ts"
    "src/market-data/streaming/market-projection-worker.ts"
    "src/inference-cost-command.ts"
    "src/streaming-diagnostics-command.ts"
    "src/glitchtip-smoke-command.ts"
    "src/valkey-command.ts"
  ];
  runtimeCommands = map (entrypoint: lib.removeSuffix ".ts" (builtins.baseNameOf entrypoint)) runtimeEntrypoints ++ [
    # Qualification verifies the replay executable against the actual trading image digest.
    "backtest-command"
  ] ++ lib.optionals research [
    "control-study-command"
    "frozen-control-command"
  ];
  bundledEntrypoints = runtimeEntrypoints ++ [ "src/verify-build-contract.ts" ];
  helpCommands = builtins.filter (command: builtins.elem command runtimeCommands) [
    "backtest-command"
    "research-command"
    "system-assessment-command"
    "jev-evaluation-command"
    "frozen-control-command"
    "control-study-command"
    "native-arrival-export-command"
    "jev-study-export-command"
    "equity-edge-screen"
    "run-macro-etf-core-rebalance"
    "run-macro-canary-etf-rebalance"
    "bayn-daily-scorecard"
    "webull-research-command"
    "control-opening-command"
    "valkey-command"
  ];
  # SHA-256 identity for bayn.intraday-alpha.behavior.v4, verified by the production executable.
  strategyBehaviorHash = "35534271edfc916e5a2801b31cfb3fc4b3d2640209666fc22c831401040fb58b";
  # Canonical hash of the compiled bayn.intraday-alpha-policy.v3 document.
  strategyParameterHash = "40d0643d63c368dd207d0f6a55b3feadb673dbd74b7c8b82bd7ee8d52e256eb5";
  strategyName = "jev";
  # Canonical bayn.strategy-protocol.v1 identity: name, behavior, parameters, and parameter schema.
  strategyProtocolHash = "91fab8597a5a70b8aed72c5d709040a775f4718905293bc2f438ec5124a4d100";
  # Canonical pure ETF sandbox policy (bayn.execution-risk-policy.v6) for the build-contract sentinel.
  # This records availability; runtime separately selects and verifies the account-bound activation policy.
  executionRiskPolicyHash = "c2aba157b7956d1f5a739928c7d6b8de3973de6868a25760fbc528d7aa1a8b1c";
  forwardPerformanceCommand = pkgs.writeShellScriptBin "bayn-forward-performance" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/forward-performance-command.js" "$@"
  '';
  inferenceCostCommand = pkgs.writeShellScriptBin "bayn-inference-cost" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/inference-cost-command.js" "$@"
  '';
  systemAssessmentCommand = pkgs.writeShellScriptBin "bayn-system-assessment" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/system-assessment-command.js" "$@"
  '';
  researchCommand = pkgs.writeShellScriptBin "bayn-research" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/research-command.js" "$@"
  '';
  evaluationCommand = pkgs.writeShellScriptBin "bayn-jev-evaluate" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/jev-evaluation-command.js" "$@"
  '';
  backtestCommand = pkgs.writeShellScriptBin "bayn-backtest" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/backtest-command.js" "$@"
  '';
  frozenControlCommand = pkgs.writeShellScriptBin "bayn-frozen-control-backtest" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/frozen-control-command.js" "$@"
  '';
  controlCommand = pkgs.writeShellScriptBin "bayn-control-study" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/control-study-command.js" "$@"
  '';
  controlOpeningCommand = pkgs.writeShellScriptBin "bayn-control-opening" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/control-opening-command.js" "$@"
  '';
  nativeArrivalExportCommand = pkgs.writeShellScriptBin "bayn-native-arrival-export" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/native-arrival-export-command.js" "$@"
  '';
  studyExportCommand = pkgs.writeShellScriptBin "bayn-jev-study-export" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/jev-study-export-command.js" "$@"
  '';
  webullResearchCommand = pkgs.writeShellScriptBin "bayn-webull-research" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/webull-research-command.js" "$@"
  '';
  equityEdgeScreenCommand = pkgs.writeShellScriptBin "bayn-equity-edge-screen" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/equity-edge-screen.js" "$@"
  '';
  gepaPython = pkgs.python312.withPackages (ps: [
    ps.boto3
    (ps.buildPythonPackage {
      pname = "gepa";
      version = "0.1.4";
      pyproject = true;
      src = pkgs.fetchurl {
        name = "8f287de942f41a6d1e0e7e5b2d576247c4bedee9.tar.gz";
        url = "https://codeload.github.com/gepa-ai/gepa/tar.gz/8f287de942f41a6d1e0e7e5b2d576247c4bedee9";
        hash = "sha256-9OiI0NGMGhPYoUw4KPhZYZd+oAG9qLyr0TkdkY3oDDM=";
      };
      build-system = [ ps.setuptools ps.wheel ps.build ];
      pythonImportsCheck = [ "gepa.optimize_anything" ];
      doCheck = false;
    })
  ]);
  gepaCommand = pkgs.writeShellScriptBin "bayn-gepa" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    export PATH="$root/bin:$PATH"
    exec ${gepaPython}/bin/python "$root/app/services/bayn/gepa/runner.py" "$@"
  '';
  gepaNativeCommand = pkgs.writeShellScriptBin "bayn-gepa-native" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    export PATH="$root/bin:$PATH"
    exec ${gepaPython}/bin/python "$root/app/services/bayn/gepa/native.py" "$@"
  '';
  buildDefine = name: value: "--define ${name}=${lib.escapeShellArg (builtins.toJSON value)}";
  buildDefines = lib.concatStringsSep " " [
    (buildDefine "__BAYN_BUILD_SOURCE_REVISION__" repoRevision)
    (buildDefine "__BAYN_BUILD_IMAGE_REPOSITORY__" imageRepository)
    (buildDefine "__BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__" strategyBehaviorHash)
    (buildDefine "__BAYN_BUILD_STRATEGY_PARAMETER_HASH__" strategyParameterHash)
    (buildDefine "__BAYN_BUILD_STRATEGY_NAME__" strategyName)
    (buildDefine "__BAYN_BUILD_STRATEGY_PROTOCOL_HASH__" strategyProtocolHash)
    (buildDefine "__BAYN_BUILD_EXECUTION_RISK_POLICY_HASH__" executionRiskPolicyHash)
  ];
  dependencySource = import ./bun-workspace-deps-source.nix { inherit lib repoRoot; };
  depsHash = import ./bayn-deps-hash.nix;
  buildCommands = [
    "bun --cwd=services/bayn run tsc"
    # Retained request hashes include PNG deflate bytes. Verify them with the exact production Node/zlib build.
    "PATH=${nodejs}/bin:$PATH bun --cwd=services/bayn run test:production-runtime"
    "bun --cwd=services/bayn build ${lib.concatStringsSep " " bundledEntrypoints} --target=node --external tigerbeetle-node --external @platformatic/kafka --entry-naming '[name].js' --outdir=dist ${buildDefines}"
    "bun services/bayn/tools/record-jev-compiler-dependencies.ts --output services/bayn/dist/backtest-command.js --source ${lib.escapeShellArg repoRevision} ${buildDefines}"
  ] ++ lib.optionals research [
    "bun services/bayn/tools/compile-frozen-control.ts --frozen-source ${frozenControl.source}/services/bayn --dependencies ${frozenControl.dependencies}/services/bayn --revision ${lib.escapeShellArg repoRevision} --output services/bayn/dist/frozen-control-command.js"
  ] ++ [
    "node services/bayn/dist/verify-build-contract.js"
    "node --check services/bayn/dist/forward-performance-verification-worker.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/forward-performance-command.js"
    "grep -F -- ${lib.escapeShellArg strategyName} services/bayn/dist/verify-build-contract.js"
    "grep -F -- ${lib.escapeShellArg strategyProtocolHash} services/bayn/dist/verify-build-contract.js"
    "grep -F -- ${lib.escapeShellArg executionRiskPolicyHash} services/bayn/dist/verify-build-contract.js"
    "rm services/bayn/dist/verify-build-contract.js"
  ] ++ map (command: "node services/bayn/dist/${command}.js --help") helpCommands ++ (if research then [
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/restate-research-server.js"
  ] else [
    "node --check services/bayn/dist/market-projection-worker.js"
    "node --check services/bayn/dist/decision-construction-worker.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/restate-execution-server.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/restate-execution-activate.js"
    "grep -F -- ${lib.escapeShellArg strategyBehaviorHash} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg strategyParameterHash} services/bayn/dist/index.js"
  ]);
  runtimeInstallPhase = ''
    mkdir -p "$out/app/services/bayn/dist"
    for command in ${lib.concatStringsSep " " runtimeCommands}; do
      cp "$TMPDIR/work/services/bayn/dist/$command.js" "$out/app/services/bayn/dist/"
    done
    cp "$TMPDIR/work/services/bayn/dist/jev-compiler-dependencies.json" "$out/app/services/bayn/dist/jev-compiler-dependencies.json"
    ${lib.optionalString research ''
    cp "$TMPDIR/work/services/bayn/dist/frozen-control-compiler.json" "$out/app/services/bayn/dist/frozen-control-compiler.json"
    mkdir -p "$out/app/services/bayn/gepa"
    cp "$TMPDIR/work/services/bayn/gepa/runner.py" "$TMPDIR/work/services/bayn/gepa/native.py" "$out/app/services/bayn/gepa/"
    ''}
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
  inherit imageName;
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
    (if research then "dist/restate-research-server.js" else "dist/index.js")
  ];
  workingDir = "/app/services/bayn";
  includeBunRuntime = false;
  extraContents = [
    nodejs
    pkgs.cacert
    inferenceCostCommand
    forwardPerformanceCommand
  ] ++ lib.optionals (!research) [ controlOpeningCommand ] ++ lib.optionals research [
    systemAssessmentCommand
    researchCommand
    gepaCommand
    gepaNativeCommand
    bun
    pkgs.git
    evaluationCommand
    backtestCommand
    frozenControlCommand
    controlCommand
    nativeArrivalExportCommand
    studyExportCommand
    webullResearchCommand
    equityEdgeScreenCommand
    gepaPython
    pkgs.go-containerregistry
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
