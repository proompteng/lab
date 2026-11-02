{
  pkgs,
  lib,
  nodejs,
  bun,
  go,
  helm,
  kustomize,
  kubeconform,
  shellcheck,
  yq,
}:

let
  tools = [
    nodejs
    bun
    go
    helm
    kustomize
    kubeconform
    shellcheck
    pkgs.jq
    yq
  ];

  toolchain = pkgs.buildEnv {
    name = "hermes-lab-toolchain";
    paths = tools;
    pathsToLink = [ "/bin" ];
  };

  exaWheel = pkgs.fetchurl {
    url = "https://files.pythonhosted.org/packages/e2/bc/7a34e904a415040ba626948d0b0a36a08cd073f12b13342578a68331be3c/exa_py-2.10.2-py3-none-any.whl";
    sha256 = "ecb2a7581f4b7a8aeb6b434acce1bbc40f92ed1d4126b2aa6029913acd904a47";
  };

  pythonDependencies =
    pkgs.runCommand "hermes-python-dependencies"
      {
        nativeBuildInputs = [ pkgs.unzip ];
      }
      ''
        mkdir -p "$out/python"
        unzip -q ${exaWheel} -d "$out/python"
      '';
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/hermes-toolchain";
  tag = "nix";
  created = "1970-01-01T00:00:01Z";
  maxLayers = 32;
  contents = [
    toolchain
    pythonDependencies
    pkgs.cacert
  ];
  config = {
    Cmd = [
      "node"
      "--version"
    ];
    Env = [
      "PATH=${lib.makeBinPath tools}"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
    Labels = {
      "org.opencontainers.image.title" = "hermes-lab-toolchain";
      "org.opencontainers.image.description" =
        "Curated Lab development and validation toolchain for Hermes";
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "proompteng.ai/toolchain.bun" = lib.getVersion bun;
      "proompteng.ai/toolchain.go" = lib.getVersion go;
      "proompteng.ai/toolchain.helm" = lib.getVersion helm;
      "proompteng.ai/toolchain.jq" = lib.getVersion pkgs.jq;
      "proompteng.ai/toolchain.kubeconform" = lib.getVersion kubeconform;
      "proompteng.ai/toolchain.kustomize" = lib.getVersion kustomize;
      "proompteng.ai/toolchain.node" = lib.getVersion nodejs;
      "proompteng.ai/toolchain.shellcheck" = lib.getVersion shellcheck;
      "proompteng.ai/toolchain.yq" = lib.getVersion yq;
      "proompteng.ai/toolchain.exa-py" = "2.10.2";
    };
    User = "10000:10000";
  };
}
