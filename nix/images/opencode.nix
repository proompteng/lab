{ pkgs, lib, repoRoot, repoRevision ? "dirty", bun, nodejs, ciToolchain }:
let
  validation = import ./opencode-validation-tools.nix { inherit pkgs; };
  cli = import ./opencode-cli.nix { inherit pkgs lib; };
  dependencySource = import ./bun-workspace-deps-source.nix { inherit lib repoRoot; };
  depsHash = import ./bayn-deps-hash.nix;
  researchRoot = import ./bayn-runtime-root.nix {
    inherit pkgs lib repoRoot dependencySource depsHash bun nodejs;
    buildCommands = [
      "bun build services/bayn/src/opencode-command.ts --target=node --format=esm --packages=bundle --outfile=research.js"
    ];
    runtimeInstallPhase = ''
      mkdir -p "$out/app/opencode" "$out/usr/bin"
      ln -s ${pkgs.coreutils}/bin/env "$out/usr/bin/env"
      cp "$TMPDIR/work/research.js" "$out/app/opencode/research.js"
      printf '{"type":"module"}\n' > "$out/app/opencode/package.json"
    '';
  };
  tools = pkgs.buildEnv {
    name = "opencode-development-tools";
    paths = [ ciToolchain cli nodejs bun pkgs.bashInteractive pkgs.openssh pkgs.gnutar pkgs.gzip pkgs.unzip pkgs.sqlite pkgs.tini pkgs.stdenv.cc pkgs.cmake pkgs.rustc pkgs.cargo pkgs.rustfmt pkgs.clippy pkgs.ruff pkgs.lua5_4 pkgs.protobuf validation.promtool validation.alloy ];
    pathsToLink = [ "/bin" ];
    ignoreCollisions = true;
  };
  start = pkgs.writeShellScriptBin "opencode-server" (builtins.readFile (repoRoot + "/services/opencode/start.sh"));
  root = pkgs.runCommand "opencode-root" { } ''
    mkdir -p "$out/usr/bin"
    ln -s ${pkgs.coreutils}/bin/env "$out/usr/bin/env"
    mkdir -p "$out/etc"
    printf 'opencode:x:65532:65532:OpenCode:/var/lib/opencode:/bin/bash\n' > "$out/etc/passwd"
    printf 'opencode:x:65532:\n' > "$out/etc/group"
  '';
in pkgs.dockerTools.buildLayeredImage {
  name = "opencode";
  tag = "latest";
  maxLayers = 64;
  includeNixDB = true;
  contents = [ tools start researchRoot root pkgs.cacert ];
  extraCommands = ''
    mkdir -p tmp workspace var/lib/opencode etc/nix nix/store \
      nix/var/log/nix/drvs nix/var/nix/profiles/per-user/opencode \
      nix/var/nix/gcroots/per-user/opencode nix/var/nix/temproots
    cat > etc/nix/nix.conf <<'CONF'
    experimental-features = nix-command flakes
    build-users-group =
    sandbox = false
    CONF
    chmod 1777 tmp
    chmod 1775 nix/store
    chmod -R u+rwX nix/var
  '';
  fakeRootCommands = ''
    chown 65532:65532 workspace var/lib/opencode nix/store
    chown -R 65532:65532 nix/var
  '';
  config = {
    User = "65532:65532";
    WorkingDir = "/workspace";
    Entrypoint = [ "${pkgs.tini}/bin/tini" "--" ];
    Cmd = [ "${start}/bin/opencode-server" ];
    Env = [
      "PATH=${tools}/bin:/bin"
      "HOME=/var/lib/opencode"
      "USER=opencode"
      "NIX_REMOTE=local"
      "XDG_DATA_HOME=/var/lib/opencode/data"
      "XDG_CONFIG_HOME=/var/lib/opencode/config"
      "XDG_STATE_HOME=/var/lib/opencode/state"
      "XDG_CACHE_HOME=/var/lib/opencode/cache"
      "TMPDIR=/tmp"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "OPENCODE_CODE_REVISION=${repoRevision}"
    ];
    ExposedPorts."4096/tcp" = { };
    Labels."org.opencontainers.image.revision" = repoRevision;
  };
}
