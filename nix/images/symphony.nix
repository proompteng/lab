{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

let
  codexCli = import ./openai-codex-cli.nix { inherit pkgs; };
in
import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "symphony";
  packageName = "@proompteng/symphony";
  depsHash = {
    x86_64-linux = "sha256-pxcAU1QozI2hE9tp9L2+D3ByfVXMsf1xgGsA0TpogUA=";
    aarch64-linux = "sha256-p2f5eokISWywtx4Ut8Exad0wXIwK8bD3Ninh7WcboH8=";
  };
  dependencyClosure = "bunCache";
  installFilters = [
    "@proompteng/codex"
    "@proompteng/otel"
    "@proompteng/symphony"
  ];
  sourcePaths = [
    "packages/codex"
    "packages/otel"
    "services/symphony"
  ];
  buildCommands = [
    "bun --cwd=packages/codex run build"
    "bun --cwd=packages/otel run build"
    "bun --cwd=services/symphony run tsc"
  ];
  command = [
    "bun"
    "src/index.ts"
    "./WORKFLOW.md"
  ];
  workingDir = "/app/services/symphony";
  env = [
    "PORT=8080"
  ];
  extraContents = [
    codexCli
    nodejs
    pkgs.bash
    pkgs.curl
    pkgs.gh
    pkgs.git
    pkgs.jq
    pkgs.python3
    pkgs.ripgrep
    pkgs.uv
    pkgs.xz
  ];
  exposedPorts = {
    "8080/tcp" = { };
  };
}
