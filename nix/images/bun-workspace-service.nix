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
  runtimeSourceFilter ? (_path: _type: true),
  buildCommands ? [ ],
  runtimeInstallPhase ? null,
  depsName ? serviceName,
  dependencyClosure ? "nodeModules",
  command,
  env ? [ ],
  extraContents ? [ ],
  exposedPorts ? { },
  workingDir ? "/app",
  maxLayers ? 24,
  runtimeRoot ? null,
  returnRuntimeRoot ? false,
  includeBunRuntime ? true,
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
      || (lib.any (prefix: isUnder prefix rel) sourcePaths && runtimeSourceFilter rel type);
  };

  installFilterArgs = lib.concatMapStringsSep " " (filter: "--filter ${lib.escapeShellArg filter}") installFilters;
  buildScript = lib.concatStringsSep "\n" buildCommands;
  useBunCacheClosure = dependencyClosure == "bunCache";
  resolvedDepsHash =
    if builtins.isAttrs depsHash then
      depsHash.${pkgs.stdenv.hostPlatform.system}
    else
      depsHash;

  deps = pkgs.stdenvNoCC.mkDerivation {
    pname = "${depsName}-bun-deps";
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
      pkgs.gnugrep
    ];

    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;

    installPhase = ''
      runHook preInstall

      export HOME="$TMPDIR/home"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      export BUN_CONFIG_CACHE_DIR="$BUN_INSTALL_CACHE_DIR"
      mkdir -p "$HOME" "$BUN_INSTALL_CACHE_DIR" "$out"
      cp -R . "$out/"
      cd "$out"

      run_bun_install() {
        local attempt
        local log
        local status

        for attempt in 1 2 3; do
          log="$TMPDIR/bun-install-attempt-$attempt.log"
          rm -f "$log"

          set +e
          bun install \
            --cache-dir "$BUN_INSTALL_CACHE_DIR" \
            --frozen-lockfile \
            --ignore-scripts \
            --backend=copyfile \
            --linker=isolated \
            --network-concurrency=1 \
            --no-progress \
            --no-summary \
            ${installFilterArgs} 2>&1 | tee "$log"
          status=''${PIPESTATUS[0]}
          set -e

          if [ "$status" -eq 0 ]; then
            return 0
          fi

          if ! grep -Eq "IntegrityCheckFailed|Integrity check failed" "$log"; then
            return "$status"
          fi

          echo "bun install failed an integrity check on attempt $attempt; clearing Bun cache before retry" >&2
          rm -rf "$BUN_INSTALL_CACHE_DIR"
          mkdir -p "$BUN_INSTALL_CACHE_DIR"
          find . -path '*/node_modules' -prune -exec rm -rf {} +
        done

        return "$status"
      }

      run_bun_install

      if [ "${dependencyClosure}" = "bunCache" ]; then
        cd "$TMPDIR"
        rm -rf "$out"
        mkdir -p "$out"
        cp -R "$BUN_INSTALL_CACHE_DIR/." "$out/"
      fi

      runHook postInstall
    '';
  };

  builtRuntimeRoot = pkgs.stdenvNoCC.mkDerivation {
    pname = "${serviceName}-runtime-root";
    version = "0";
    src = runtimeSource;

    nativeBuildInputs = [
      bun
      nodejs
      pkgs.bash
      pkgs.coreutils
      pkgs.findutils
    ];

    dontConfigure = true;

    buildPhase = ''
      runHook preBuild

      export HOME="$TMPDIR/home"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      export BUN_CONFIG_CACHE_DIR="$BUN_INSTALL_CACHE_DIR"
      mkdir -p "$HOME" "$BUN_INSTALL_CACHE_DIR" "$TMPDIR/work"
      ${
        if useBunCacheClosure then
          ''
            cp -R ${deps}/. "$BUN_INSTALL_CACHE_DIR/"
            cp -R ${depsSource}/. "$TMPDIR/work/"
            chmod -R u+w "$TMPDIR/work"
            cp -R . "$TMPDIR/work/"
            chmod -R u+w "$BUN_INSTALL_CACHE_DIR" "$TMPDIR/work"
          ''
        else
          ''
            cp -R ${deps}/. "$TMPDIR/work/"
            chmod -R u+w "$TMPDIR/work"
            cp -R . "$TMPDIR/work/"
          ''
      }
      cd "$TMPDIR/work"
      ${
        if useBunCacheClosure then
          ''
            bun install \
              --cache-dir "$BUN_INSTALL_CACHE_DIR" \
              --offline \
              --frozen-lockfile \
              --ignore-scripts \
              --backend=copyfile \
              --linker=isolated \
              --network-concurrency=1 \
              --no-progress \
              --no-summary \
              ${installFilterArgs}
          ''
        else
          ""
      }
      ${buildScript}

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/app"
      ${
        if runtimeInstallPhase == null then
          ''
            cp -R "$TMPDIR/work/." "$out/app/"
          ''
        else
          runtimeInstallPhase
      }

      find "$out/app" -path '*/node_modules/.bun/node_modules' -type d -exec find {} -xtype l -delete \;

      runHook postInstall
    '';
  };

  resolvedRuntimeRoot = if runtimeRoot == null then builtRuntimeRoot else runtimeRoot;

  runtimeTools = (lib.optionals includeBunRuntime [ bun ]) ++ [
    pkgs.busybox
    pkgs.coreutils
  ] ++ extraContents;
  runtimePath = lib.makeBinPath runtimeTools;
in
if returnRuntimeRoot then builtRuntimeRoot else pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/${imageName}";
  tag = "nix";
  inherit maxLayers;
  contents = [
    resolvedRuntimeRoot
    pkgs.busybox
    pkgs.cacert
    pkgs.coreutils
  ] ++ (lib.optionals includeBunRuntime [ bun ]) ++ extraContents;
  extraCommands = ''
    mkdir -p tmp var/tmp
    chmod 1777 tmp var/tmp
  '';
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
