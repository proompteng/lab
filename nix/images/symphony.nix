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
    x86_64-linux = "sha256-OtO6UdBrExseHBP2UubhcD15AIZw1e1I+xhC721F0qM=";
    aarch64-linux = "sha256-9gpI1De5iNmVMhGgCuf0Yi+TI7yt+itq1JJqCLcJgN0=";
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
