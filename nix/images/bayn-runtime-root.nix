{
  pkgs,
  lib,
  repoRoot,
  dependencySource,
  depsHash,
  bun,
  nodejs,
  buildCommands,
  runtimeInstallPhase,
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
  isUnder = prefix: rel: rel == prefix || lib.hasPrefix "${prefix}/" rel;
  sourcePaths = [
    "services/bayn"
    "packages/scripts/src/bayn/update-manifests.ts"
  ];
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
  resolvedDepsHash = depsHash.${pkgs.stdenv.hostPlatform.system};
  deps = pkgs.stdenvNoCC.mkDerivation {
    pname = "bayn-bun-deps";
    version = "0";
    src = dependencySource;

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
            --filter '@proompteng/bayn' 2>&1 | tee "$log"
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

      runHook postInstall
    '';
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "bayn-runtime-root";
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
    cp -R ${deps}/. "$TMPDIR/work/"
    chmod -R u+w "$TMPDIR/work"
    cp -R . "$TMPDIR/work/"
    cd "$TMPDIR/work"
    ${lib.concatStringsSep "\n" buildCommands}

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/app"
    ${runtimeInstallPhase}
    find "$out/app" -path '*/node_modules/.bun/node_modules' -type d -exec find {} -xtype l -delete \;

    runHook postInstall
  '';
}
