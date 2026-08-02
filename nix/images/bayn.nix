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
  # SHA-256 identity for bayn.risk-balanced-trend.behavior.v3, verified by the production executable.
  strategyBehaviorHash = "9e87fe0f66048c48da2191ef1fae36ef3ee0eb4ddcd036ef40881f0fe0f6eb42";
  # Canonical hash of the compiled bayn.risk-balanced-trend.protocol.v4 document.
  strategyParameterHash = "19bc51c7361b181aa48845d178cb63373b3f2e017bcbea1cf3b70ab16647f8a9";
  forwardPerformanceCommand = pkgs.writeShellScriptBin "bayn-forward-performance" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/forward-performance-command.js" "$@"
  '';
  qualificationCandidateCommand = pkgs.writeShellScriptBin "bayn-qualification-candidate" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/qualification-candidate-command.js" "$@"
  '';
  qualificationAuditCommand = pkgs.writeShellScriptBin "bayn-qualification-audit" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/node" "$root/app/services/bayn/dist/qualification-audit-command.js" "$@"
  '';
  qualificationCollectorCommand = pkgs.writeShellScriptBin "bayn-qualification-collector" ''
    set -eu
    root="''${BAYN_IMAGE_ROOT:-}"
    exec "$root/bin/bun" "$root/app/services/bayn/dist/qualification-collector-command.js" "$@"
  '';
  buildDefine = name: value: "--define ${name}=${lib.escapeShellArg (builtins.toJSON value)}";
  dependencySource = import ./bun-workspace-deps-source.nix { inherit lib repoRoot; };
  depsHash = {
    x86_64-linux = "sha256-Q5PHTSy/pvZRncOcPD/u2WkmtMO9a63xYv1Mo3ZT5ow=";
    aarch64-linux = "sha256-RsZvQF78pOgM/MJMznUvTesMo0QNBoVVJWAKuZNs/TM=";
  };
  buildCommands = [
    "bun --cwd=services/bayn run tsc"
    (
      "bun --cwd=services/bayn build src/index.ts src/verify-build-contract.ts src/qualification-audit-command.ts src/qualification-candidate-command.ts src/qualification-collector-command.ts src/forward-performance-command.ts --target=node "
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
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/qualification-collector-command.js"
    "grep -F -- ${lib.escapeShellArg repoRevision} services/bayn/dist/forward-performance-command.js"
    "grep -F -- ${lib.escapeShellArg strategyBehaviorHash} services/bayn/dist/index.js"
    "grep -F -- ${lib.escapeShellArg strategyParameterHash} services/bayn/dist/index.js"
  ];
  runtimeInstallPhase = ''
    mkdir -p "$out/app/services/bayn/dist" "$out/app/services/bayn/node_modules/tigerbeetle-node"
    cp "$TMPDIR/work/services/bayn/dist/index.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/qualification-audit-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/qualification-candidate-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/qualification-collector-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/dist/forward-performance-command.js" "$out/app/services/bayn/dist/"
    cp "$TMPDIR/work/services/bayn/package.json" "$out/app/services/bayn/package.json"
    cp -R -L "$TMPDIR/work/services/bayn/node_modules/tigerbeetle-node/." \
      "$out/app/services/bayn/node_modules/tigerbeetle-node/"
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
  includeBunRuntime = true;
  extraContents = [
    nodejs
    pkgs.cacert
    pkgs.git
    forwardPerformanceCommand
    qualificationCandidateCommand
    qualificationAuditCommand
    qualificationCollectorCommand
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
