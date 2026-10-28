{
  pkgs,
  lib,
  repoRoot,
  repoRevision ? "dirty",
  bun,
  nodejs,
}:

let
  openCode = import ./opencode-cli.nix { inherit pkgs lib; };
  frozenControl = import ./bayn-frozen-control.nix { inherit pkgs lib bun nodejs; };
  imageRepository = "registry.ide-newton.ts.net/lab/bayn";
  # SHA-256 identity for bayn.chart-first-entry.behavior.v1, verified by the production executable.
  strategyBehaviorHash = "60c3149349abb7bbfb763c7418d4c12065cb56c3554ea9cbbf1667bc720379c5";
  # Canonical hash of the compiled bayn.jev.protocol.v29 document.
  strategyParameterHash = "95425250b00847210f5a4f23513a8bb5d0cbfd2100e52bed617dd12d3ecb822a";
  strategyName = "jev";
  # Canonical bayn.strategy-protocol.v1 identity: name, behavior, parameters, and parameter schema.
  strategyProtocolHash = "ddbf5fc1524aef87050a745da3b01c943dcfb0f9a6720fd9eb68b0da1b7b49e1";
  # Canonical increased sandbox policy for the build-contract sentinel, without embedding a broker account identity.
  # This records availability; runtime separately selects and verifies the account-bound activation policy.
  executionRiskPolicyHash = "5f0e0cd4aa5ee11556bede5ab9a6286744b589ef08efe2d1f8accbb30e63eeab";
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
  gepaPython = pkgs.python312.withPackages (ps: [
    ps.boto3
    (ps.buildPythonPackage {
      pname = "gepa";
      version = "0.1.4";
      pyproject = true;
      src = pkgs.fetchurl {
        url = "https://github.com/gepa-ai/gepa/archive/8f287de942f41a6d1e0e7e5b2d576247c4bedee9.tar.gz";
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
    "BAYN_TEST_OPENCODE_BINARY=${openCode}/bin/opencode bun test services/bayn/src/opencode/server.integration.test.ts"
    "bun --cwd=services/bayn run build ${buildDefines}"
    "bun services/bayn/tools/record-jev-compiler-dependencies.ts --output services/bayn/dist/backtest-command.js --source ${lib.escapeShellArg repoRevision} ${buildDefines}"
    "bun services/bayn/tools/compile-frozen-control.ts --frozen-source ${frozenControl.source}/services/bayn --dependencies ${frozenControl.dependencies}/services/bayn --revision ${lib.escapeShellArg repoRevision} --output services/bayn/dist/frozen-control-command.js"
    "node services/bayn/dist/verify-build-contract.js"
    "node services/bayn/dist/research-command.js --help"
    "node services/bayn/dist/jev-evaluation-command.js --help"
    "node services/bayn/dist/backtest-command.js --help"
    "node services/bayn/dist/frozen-control-command.js --help"
    "node services/bayn/dist/control-study-command.js --help"
    "node services/bayn/dist/valkey-command.js --help"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/forward-performance-command.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/restate-execution-server.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/restate-execution-activate.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/restate-research-server.js"
    "grep -F -- ${lib.escapeShellArg strategyBehaviorHash} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg strategyParameterHash} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg strategyName} services/bayn/dist/verify-build-contract.js"
    "grep -F -- ${lib.escapeShellArg strategyProtocolHash} services/bayn/dist/verify-build-contract.js"
    "grep -F -- ${lib.escapeShellArg executionRiskPolicyHash} services/bayn/dist/verify-build-contract.js"
    "rm services/bayn/dist/verify-build-contract.js"
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/services/bayn/dist"
    cp "$TMPDIR/work/services/bayn/dist/"*.js "$out/app/services/bayn/dist/"
    rm "$out/app/services/bayn/dist/opencode-command.js"
    cp "$TMPDIR/work/services/bayn/dist/jev-compiler-dependencies.json" "$out/app/services/bayn/dist/jev-compiler-dependencies.json"
    cp "$TMPDIR/work/services/bayn/dist/frozen-control-compiler.json" "$out/app/services/bayn/dist/frozen-control-compiler.json"
    cp "$TMPDIR/work/services/bayn/package.json" "$out/app/services/bayn/package.json"
    mkdir -p "$out/app/services/bayn/gepa"
    cp "$TMPDIR/work/services/bayn/gepa/runner.py" "$TMPDIR/work/services/bayn/gepa/native.py" "$out/app/services/bayn/gepa/"
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
    inferenceCostCommand
    researchCommand
    gepaCommand
    gepaNativeCommand
    bun
    pkgs.git
    evaluationCommand
    backtestCommand
    frozenControlCommand
    controlCommand
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
