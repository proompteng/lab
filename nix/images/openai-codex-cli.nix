{ pkgs }:

let
  codexVersion = "0.144.0";
  codexPlatform =
    {
      x86_64-linux = {
        npmVersion = "${codexVersion}-linux-x64";
        vendor = "x86_64-unknown-linux-musl";
        hash = "sha256-ORo3k9If7/CNotkTLwEQfdVvpaSKFY4j0VxtVuNPfLI=";
      };
      aarch64-linux = {
        npmVersion = "${codexVersion}-linux-arm64";
        vendor = "aarch64-unknown-linux-musl";
        hash = "sha256-Ml08+sTrGkmHMFhlgGA2kcRs8022vIn5ffo4XidaWqk=";
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
