{ pkgs, lib, repoRoot }:
let
  source = lib.fileset.toSource {
    root = repoRoot;
    fileset = lib.fileset.unions (map (path: repoRoot + "/${path}") [
      "services/relay/Cargo.toml" "services/relay/Cargo.lock" "services/relay/src"
      "packages/platform-client" "proto/proompteng/authz/v1/platform.proto" "proto/proompteng/relay"
    ]);
  };
in pkgs.rustPlatform.buildRustPackage {
  pname = "relay";
  version = "0.1.0";
  src = source;
  cargoRoot = "services/relay";
  buildAndTestSubdir = "services/relay";
  cargoLock.lockFile = repoRoot + "/services/relay/Cargo.lock";
  nativeBuildInputs = [ pkgs.cmake pkgs.protobuf ];
  PROTOC = "${pkgs.protobuf}/bin/protoc";
}
