{ pkgs }:
let
  releases = {
    x86_64-linux = {
      architecture = "amd64";
      prometheusHash = "e811827af26d822afb09a4f28314f61b618b12cff5369835a67f674d8b46f39a";
      alloyHash = "3694ea4e1044b367e1c21ffe28117f209c5989fa5e604d000321809f871ab701";
    };
    aarch64-linux = {
      architecture = "arm64";
      prometheusHash = "173389cc42bf09c4e6e54cb53fa07a5a835d7c261e14775d2183181d6e385d1c";
      alloyHash = "fbeaf099b7c90b8b83dfa4781601c1181d8d06e89af34b846680c86ce08f725c";
    };
  };
  release = releases.${pkgs.stdenv.hostPlatform.system};
  binary = { name, version, url, sha256, sourceRoot, path }:
    pkgs.stdenvNoCC.mkDerivation {
      pname = name;
      inherit version sourceRoot;
      src = pkgs.fetchurl { inherit url sha256; };
      nativeBuildInputs = [ pkgs.unzip pkgs.autoPatchelfHook ];
      buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.zlib pkgs.openssl ];
      dontConfigure = true;
      dontBuild = true;
      installPhase = ''
        install -Dm755 ${path} "$out/bin/${name}"
      '';
      doInstallCheck = true;
      installCheckPhase = ''
        tool_version="$("$out/bin/${name}" --version 2>&1)"
        printf '%s\n' "$tool_version" | grep -F '${version}'
      '';
    };
in {
  promtool = binary {
    name = "promtool";
    version = "3.5.0";
    url = "https://github.com/prometheus/prometheus/releases/download/v3.5.0/prometheus-3.5.0.linux-${release.architecture}.tar.gz";
    sha256 = release.prometheusHash;
    sourceRoot = "prometheus-3.5.0.linux-${release.architecture}";
    path = "promtool";
  };
  alloy = binary {
    name = "alloy";
    version = "1.19.2";
    url = "https://github.com/grafana/alloy/releases/download/v1.19.2/alloy-linux-${release.architecture}.zip";
    sha256 = release.alloyHash;
    sourceRoot = ".";
    path = "alloy-linux-${release.architecture}";
  };
}
