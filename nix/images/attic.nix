{ pkgs, lib }:

pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/attic";
  tag = "nix";
  contents = [
    pkgs.attic-client
    pkgs.attic-server
    pkgs.cacert
    pkgs.coreutils
  ];
  config = {
    Entrypoint = [ "atticd" ];
    Env = [
      "PATH=${lib.makeBinPath [
        pkgs.attic-client
        pkgs.attic-server
        pkgs.coreutils
      ]}"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
    ExposedPorts = {
      "8080/tcp" = { };
    };
    User = "65532:65532";
  };
}
