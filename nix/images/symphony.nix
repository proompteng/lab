{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
}:

let
  codexVersion = "0.142.4";
  codexPlatform =
    {
      x86_64-linux = {
        npmVersion = "${codexVersion}-linux-x64";
        vendor = "x86_64-unknown-linux-musl";
        hash = "sha256-PVplrOt1q7N8fo4DHbGgw00LpV1dJjxeb0MMIefebHw=";
      };
      aarch64-linux = {
        npmVersion = "${codexVersion}-linux-arm64";
        vendor = "aarch64-unknown-linux-musl";
        hash = "sha256-ERM4csGF8zXPQI7dE5U7UngI39jmfZhEFyOu7N+wVD4=";
      };
    }
    .${pkgs.stdenv.hostPlatform.system}
      or (throw "Codex CLI is not packaged for ${pkgs.stdenv.hostPlatform.system}");

  codexCli = pkgs.stdenvNoCC.mkDerivation {
    pname = "openai-codex-cli";
    version = codexVersion;

    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@openai/codex/-/codex-${codexPlatform.npmVersion}.tgz";
      hash = codexPlatform.hash;
    };
    sourceRoot = "package/vendor/${codexPlatform.vendor}";

    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;

    installPhase = ''
      runHook preInstall
      mkdir -p "$out/bin" "$out/libexec/openai-codex"
      cp -R . "$out/libexec/openai-codex/"
      ln -s "$out/libexec/openai-codex/bin/codex" "$out/bin/codex"
      runHook postInstall
    '';
  };
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
