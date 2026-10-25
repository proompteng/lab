{
  pkgs,
  lib,
  repoRoot,
  repoRevision ? "dirty",
}:

let
  source = lib.fileset.toSource {
    root = repoRoot;
    fileset = lib.fileset.unions (
      map (relative: repoRoot + "/${relative}") [
        "services/ofz/Cargo.toml"
        "services/ofz/Cargo.lock"
        "services/ofz/build.rs"
        "services/ofz/src"
        "services/ofz/migrations"
        "services/ofz/schema.zed"
        "services/ofz/operations.json"
        "services/tengri/migrations"
        "proto/proompteng/authz"
      ]
    );
  };
  ofz = pkgs.rustPlatform.buildRustPackage {
    pname = "ofz";
    version = "0.1.0";
    src = source;
    cargoRoot = "services/ofz";
    buildAndTestSubdir = "services/ofz";
    cargoLock.lockFile = repoRoot + "/services/ofz/Cargo.lock";
    nativeBuildInputs = [
      pkgs.cmake
      pkgs.protobuf
    ];
    PROTOC = "${pkgs.protobuf}/bin/protoc";
    cargoTestFlags = [ "--lib" ];
  };
  auditPython = pkgs.python3.withPackages (python: [
    python.minio
    python.psycopg
  ]);
  auditSource = pkgs.writeText "ofz-audit-export.py" (
    builtins.readFile (repoRoot + "/services/ofz/audit_export.py")
  );
  auditExport = pkgs.writeShellScriptBin "ofz-audit-export" ''
    exec ${auditPython}/bin/python ${auditSource} "$@"
  '';
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/ofz";
  tag = "nix";
  contents = [
    ofz
    auditExport
    auditPython
    pkgs.cacert
  ];
  config = {
    Entrypoint = [ "${ofz}/bin/ofz" ];
    Cmd = [ "serve" ];
    Env = [
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "APP_SOURCE_REVISION=${repoRevision}"
    ];
    User = "65532:65532";
    ExposedPorts."9443/tcp" = { };
    Labels = {
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "org.opencontainers.image.revision" = repoRevision;
    };
  };
}
