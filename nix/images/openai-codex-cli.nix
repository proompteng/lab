{ pkgs }:

let
  codexVersion = "0.153.4";
  codexPlatform =
    {
      x86_64-linux = {
        npmVersion = "${codexVersion}-linux-x64";
        vendor = "x86_64-unknown-linux-musl";
        hash = "sha256-VIGMufzjNgzG5Ez8WpaVLNXBJD77Q8vkiOEd2oRmPgg=";
      };
      aarch64-linux = {
        npmVersion = "${codexVersion}-linux-arm64";
        vendor = "aarch64-unknown-linux-musl";
        hash = "sha256-Q5wN0NaSP2B7TlzR4wecEvC4b25QB/B+N31q0l4te7k=";
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
