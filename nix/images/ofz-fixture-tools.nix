{
  pkgs,
  lib,
  runnerTools,
}:

let
  # This Nixpkgs revision provides signed binaries for the production PostgreSQL release on both Linux architectures.
  fixtureNixpkgs = builtins.getFlake "github:NixOS/nixpkgs/e74269b08694028da88b3925708226a1d9ba9427";
  postgres = fixtureNixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system}.postgresql_18;
in
assert lib.getVersion postgres == lib.getVersion runnerTools.postgres;
pkgs.buildEnv {
  name = "ofz-fixture-tools";
  paths = [ postgres runnerTools.spicedb pkgs.openssl ];
}
