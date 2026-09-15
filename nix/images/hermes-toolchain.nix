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
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/hermes-toolchain";
  tag = "nix";
  created = "1970-01-01T00:00:01Z";
  maxLayers = 32;
  contents = [
    toolchain
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
      "org.opencontainers.image.description" = "Curated Lab development and validation toolchain for Hermes";
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
    };
    User = "10000:10000";
  };
}
