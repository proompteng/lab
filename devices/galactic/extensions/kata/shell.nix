{ system ? builtins.currentSystem }:
let
  lock = builtins.fromJSON (builtins.readFile ../../../../flake.lock);
  source = builtins.fetchTree lock.nodes.nixpkgs.locked;
  pkgs = import source.outPath { inherit system; };
in
assert pkgs.stdenv.hostPlatform.isLinux;
pkgs.mkShell {
  nativeBuildInputs = [
    pkgs.clang
    pkgs.pkg-config
    pkgs.protobuf
    pkgs.gnumake
    pkgs.zstd
    pkgs.gnutar
    pkgs.git
    pkgs.docker-client
    pkgs.yq-go
  ];
  buildInputs = [
    pkgs.libseccomp
    pkgs.util-linux
    pkgs.openssl
  ];
  LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
  PROTOC = "${pkgs.protobuf}/bin/protoc";
}
