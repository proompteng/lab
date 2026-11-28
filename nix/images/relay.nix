{ pkgs, lib, repoRoot, repoRevision ? "dirty" }:
let relay = import ../packages/relay.nix { inherit pkgs lib repoRoot; };
in pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/relay";
  tag = "nix";
  contents = [ relay pkgs.cacert ];
  config = {
    Entrypoint = [ "${relay}/bin/relay" ];
    User = "65532:65532";
    Env = [ "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" "APP_SOURCE_REVISION=${repoRevision}" ];
    ExposedPorts."9443/tcp" = {};
    Labels = {
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "org.opencontainers.image.revision" = repoRevision;
    };
  };
}
