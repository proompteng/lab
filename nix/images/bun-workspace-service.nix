{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
  serviceName,
  imageName ? serviceName,
  packageName,
  depsHash,
  installFilters,
  sourcePaths,
  buildCommands ? [ ],
  command,
  env ? [ ],
  extraContents ? [ ],
  exposedPorts ? { },
  workingDir ? "/app",
}:

let
  repoRootString = toString repoRoot;

  relativePath =
    path:
    let
      pathString = toString path;
      prefix = "${repoRootString}/";
    in
    if pathString == repoRootString then
      ""
    else if lib.hasPrefix prefix pathString then
      lib.removePrefix prefix pathString
    else
      pathString;

  isPackageManifest = rel:
    rel == "package.json"
    || rel == "bun.lock"
    || rel == "bunfig.toml"
    || rel == ".npmrc"
    || rel == "tsconfig.base.json"
    || lib.hasSuffix "/package.json" rel;

  isUnder = prefix: rel: rel == prefix || lib.hasPrefix "${prefix}/" rel;

  depsSource = lib.cleanSourceWith {
    src = repoRoot;
    filter = path: type:
      type == "directory" || isPackageManifest (relativePath path);
  };

  runtimeSource = lib.cleanSourceWith {
    src = repoRoot;
    filter = path: type:
      let
        rel = relativePath path;
      in
      type == "directory"
      || rel == "package.json"
      || rel == "bun.lock"
      || rel == "bunfig.toml"
      || rel == ".npmrc"
      || rel == "tsconfig.base.json"
      || lib.any (prefix: isUnder prefix rel) sourcePaths;
  };

  installFilterArgs = lib.concatMapStringsSep " " (filter: "--filter ${lib.escapeShellArg filter}") installFilters;
  buildScript = lib.concatStringsSep "\n" buildCommands;
  resolvedDepsHash =
    if builtins.isAttrs depsHash then
      depsHash.${pkgs.stdenv.hostPlatform.system}
    else
      depsHash;

  deps = pkgs.stdenvNoCC.mkDerivation {
    pname = "${serviceName}-bun-deps";
    version = "0";
    src = depsSource;

    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = resolvedDepsHash;

    nativeBuildInputs = [
      bun
      pkgs.bash
      pkgs.coreutils
      pkgs.findutils
    ];

    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;

    installPhase = ''
      runHook preInstall

      export HOME="$TMPDIR/home"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      mkdir -p "$HOME" "$BUN_INSTALL_CACHE_DIR" "$out"
      cp -R . "$out/"
      cd "$out"
      bun install --frozen-lockfile --ignore-scripts ${installFilterArgs}

      runHook postInstall
    '';
  };

  appRoot = pkgs.stdenvNoCC.mkDerivation {
    pname = "${serviceName}-runtime-root";
    version = "0";
    src = runtimeSource;

    nativeBuildInputs = [
      bun
      nodejs
      pkgs.bash
      pkgs.coreutils
    ];

    dontConfigure = true;

    buildPhase = ''
      runHook preBuild

      export HOME="$TMPDIR/home"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      mkdir -p "$HOME" "$BUN_INSTALL_CACHE_DIR" "$TMPDIR/work"
      cp -R ${deps}/. "$TMPDIR/work/"
      chmod -R u+w "$TMPDIR/work"
      cp -R . "$TMPDIR/work/"
      cd "$TMPDIR/work"
      ${buildScript}

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/app"
      cp -R "$TMPDIR/work/." "$out/app/"

      runHook postInstall
    '';
  };

  runtimePath = lib.makeBinPath ([
    bun
    pkgs.busybox
    pkgs.coreutils
  ] ++ extraContents);
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/${imageName}";
  tag = "nix";
  contents = [
    appRoot
    bun
    pkgs.busybox
    pkgs.cacert
    pkgs.coreutils
  ] ++ extraContents;
  config = {
    Entrypoint = command;
    WorkingDir = workingDir;
    Env = [
      "PATH=${runtimePath}"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "NODE_ENV=production"
      "BUN_INSTALL_CACHE_DIR=/tmp/bun-cache"
    ] ++ env;
    ExposedPorts = exposedPorts;
    Labels = {
      "org.opencontainers.image.title" = packageName;
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "proompteng.ai/nix-package-attr" = "${serviceName}-image";
    };
  };
}
