{ pkgs }:

let
  agyVersion = "1.5.18";
  agyBuild = "${agyVersion}-6386224290725888";
  agyPlatform =
    {
      x86_64-linux = {
        archivePath = "linux-x64-musl/cli_linux_x64_musl.tar.gz";
        hash = "sha512-k4zHHGCeyqpTWI256+k3IFke2Xf408noYqMCwmb/AGjcGZJyKqwB/ltFziP3ciZZgObfKxkwSLk7vZR6QzuuKw==";
      };
      aarch64-linux = {
        archivePath = "linux-arm-musl/cli_linux_arm64_musl.tar.gz";
        hash = "sha512-dE2o48ATWrgHBbEOYhtxZOJ9XcMMWPdUl8oPlKq+n6fndzHAD9oo8PCO89uxMKEacwFy1QiCGObjZlMZYpqTEQ==";
      };
    }
    .${pkgs.stdenv.hostPlatform.system}
      or (throw "Antigravity CLI is not packaged for ${pkgs.stdenv.hostPlatform.system}");
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "antigravity-cli";
  version = agyVersion;

  src = pkgs.fetchurl {
    url = "https://storage.googleapis.com/antigravity-public/antigravity-cli/${agyBuild}/${agyPlatform.archivePath}";
    hash = agyPlatform.hash;
  };
  sourceRoot = ".";

  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 antigravity "$out/bin/agy"
    runHook postInstall
  '';
}
