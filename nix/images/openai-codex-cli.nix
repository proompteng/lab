{ pkgs }:

let
  codexVersion = "0.166.0";
  codexPlatform =
    {
      x86_64-linux = {
        npmVersion = "${codexVersion}-linux-x64";
        vendor = "x86_64-unknown-linux-musl";
        hash = "sha256-y8AKJtPQ4s7vxL6IkfioHvHjSbOxdbwK4wh2K8AB/ZM=";
      };
      aarch64-linux = {
        npmVersion = "${codexVersion}-linux-arm64";
        vendor = "aarch64-unknown-linux-musl";
        hash = "sha256-kEToQDl4ZPxsU50TcZsl+yars11TUzZsur97RVVAas0=";
      };
    }
    .${pkgs.stdenv.hostPlatform.system}
      or (throw "Codex CLI is not packaged for ${pkgs.stdenv.hostPlatform.system}");
in
pkgs.stdenvNoCC.mkDerivation {
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
}
