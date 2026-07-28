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
  buildDefine = name: value: "--define ${name}=${lib.escapeShellArg (builtins.toJSON value)}";
in
import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "bayn";
  packageName = "@proompteng/bayn";
  depsHash = {
    x86_64-linux = "sha256-3/ypVWbFqQkrWzEYntOFsJ0Qjsyd6kJJrnNsQVJXMzA=";
    aarch64-linux = "sha256-LItp5mJ1QkOiCRCVODH3QTyNQTmAztZam1FzoAkuIVo=";
  };
  installFilters = [
    "@proompteng/bayn"
  ];
  sourcePaths = [
    "services/bayn"
    "packages/scripts/src/bayn/update-manifests.ts"
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
