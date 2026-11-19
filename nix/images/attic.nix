{ pkgs, lib }:

let
  # Hosted runners can reach Attic, but cannot follow redirects to its private S3 endpoint.
  atticServer = pkgs.attic-server.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./attic-stream-nars.patch ];
  });
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/attic";
  tag = "nix";
  contents = [
    pkgs.attic-client
    atticServer
    pkgs.cacert
    pkgs.coreutils
  ];
  config = {
    Entrypoint = [ "atticd" ];
    Env = [
      "PATH=${lib.makeBinPath [
        pkgs.attic-client
        atticServer
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
