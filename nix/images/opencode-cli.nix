{ pkgs, lib }:
let
  releases = {
    x86_64-linux = {
      architecture = "x64";
      hash = "sha512-WVO7TebdgAcPnoOQ390ny3oyqpCH5MpPU76lHXml3G/wJz6QLxjzsQW2Lrabiewg046yAeKlf+1nPPZElF1qPw==";
    };
    aarch64-linux = {
      architecture = "arm64";
      hash = "sha512-Two8nCzLbQC5jZc5oAeize3hCPKSawa/tCm2N7s6EIqeEcdPU7VAQNYiyEkrC4UhDJk91EpplsizPg8XmHCdmA==";
    };
  };
  release = releases.${pkgs.stdenv.hostPlatform.system};
in
pkgs.stdenv.mkDerivation {
  pname = "opencode";
  version = "2.1.3";
  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@opencode/cli-linux-${release.architecture}/-/cli-linux-${release.architecture}-2.1.3.tgz";
    inherit (release) hash;
  };
  sourceRoot = "package";
  nativeBuildInputs = [ pkgs.autoPatchelfHook ];
  buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.openssl pkgs.zlib ];
  dontBuild = true;
  # Stripping removes the appended Bun application payload.
  dontStrip = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 bin/opencode "$out/bin/opencode"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    export XDG_DATA_HOME="$TMPDIR/opencode-data"
    export XDG_CONFIG_HOME="$TMPDIR/opencode-config"
    export XDG_CACHE_HOME="$TMPDIR/opencode-cache"
    export XDG_STATE_HOME="$TMPDIR/opencode-state"
    opencode_version="$("$out/bin/opencode" --version)"
    printf '%s\n' "$opencode_version"
    test "$opencode_version" = "opencode v2.1.3"
  '';
  meta = {
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" "aarch64-linux" ];
  };
}
