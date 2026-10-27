{
  pkgs,
  lib,
  bun,
  nodejs,
}:
let
  # An immutable build input, independently authenticated by the original service Git tree in the compiler.
  source = (builtins.fetchGit {
    url = "https://github.com/proompteng/lab.git";
    rev = "ef6a069fc121cbe54d148027fe091e3e7f58da9b";
    shallow = true;
  }).outPath;
  sourcePath = /. + builtins.unsafeDiscardStringContext source;
  dependencySource = import "${source}/nix/images/bun-workspace-deps-source.nix" {
    inherit lib;
    repoRoot = sourcePath;
  };
  dependencies = import "${source}/nix/images/bayn-runtime-root.nix" {
    inherit pkgs lib bun nodejs dependencySource;
    repoRoot = sourcePath;
    depsHash = {
      x86_64-linux = "sha256-6QtJftiUs06mYWX4uXq/6owrkFL2HzBZpal2fQt8lKo=";
      aarch64-linux = "sha256-OtS04OMVTmP4Llnm9tOYlz3Ngen8rzfFMo4GWCUbyjU=";
    };
    buildCommands = [ ];
    runtimeInstallPhase = ''
      mkdir -p "$out/services/bayn"
      cp -R "$TMPDIR/work/node_modules" "$out/node_modules"
      cp -R "$TMPDIR/work/services/bayn/node_modules" "$out/services/bayn/node_modules"
    '';
  };
in
{
  inherit source dependencies;
}
