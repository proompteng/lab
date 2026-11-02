{
  pkgs,
  lib,
  repoRoot,
}:

let
  python = pkgs.python311;
  torghutRoot = repoRoot + "/services/torghut";
  torghutRootString = toString torghutRoot;

  relativePath =
    path:
    let
      pathString = toString path;
      prefix = "${torghutRootString}/";
    in
    if pathString == torghutRootString then "" else lib.removePrefix prefix pathString;

  depsSource = lib.cleanSourceWith {
    src = torghutRoot;
    filter = path: type:
      type == "directory"
      || builtins.elem (relativePath path) [
        "pyproject.toml"
        "uv.lock"
        "README.md"
      ];
  };

  runtimeSource = lib.cleanSourceWith {
    src = torghutRoot;
    filter = path: type:
      let
        rel = relativePath path;
      in
      type == "directory"
      || builtins.elem rel [
        "alembic.ini"
        "README.md"
      ]
      || lib.hasPrefix "app/" rel
      || lib.hasPrefix "config/" rel
      || lib.hasPrefix "migrations/" rel
      || lib.hasPrefix "scripts/" rel;
  };

  pythonDeps = pkgs.stdenv.mkDerivation {
    pname = "torghut-python-deps";
    version = "0";
    src = depsSource;

    nativeBuildInputs = [
      python
      pkgs.bash
      pkgs.coreutils
      pkgs.findutils
      pkgs.pkg-config
      pkgs.uv
    ];

    buildInputs = [
      pkgs.openssl
      pkgs.postgresql.lib
      pkgs.zlib
    ];

    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;

    installPhase = ''
      runHook preInstall

      export HOME="$TMPDIR/home"
      export UV_CACHE_DIR="$TMPDIR/uv-cache"
      export UV_LINK_MODE=copy
      export UV_PROJECT_ENVIRONMENT="$out/venv"
      mkdir -p "$HOME" "$UV_CACHE_DIR"

      uv sync \
        --frozen \
        --no-dev \
        --no-install-project \
        --python ${python}/bin/python3.11

      find "$out" -name __pycache__ -type d -prune -exec rm -rf {} +
      find "$out" -name '*.pyc' -delete

      runHook postInstall
    '';
  };

  appRoot = pkgs.stdenvNoCC.mkDerivation {
    pname = "torghut-runtime-root";
    version = "0";
    src = runtimeSource;

    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.findutils
    ];

    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;

    installPhase = ''
      runHook preInstall
      mkdir -p "$out/app"
      cp -R . "$out/app/"
      test -f "$out/app/app/main.py"
      test -f "$out/app/app/trading/forecast_runtime.py"
      test -f "$out/app/app/trading/lean_runtime.py"
      test -f "$out/app/config/economic-policy-v1.json"
      runHook postInstall
    '';
  };

  runtimePath = lib.makeBinPath [
    python
    pkgs.bash
    pkgs.busybox
    pkgs.coreutils
    pkgs.curl
    pkgs.kubectl
    pkgs.pigz
    pkgs.zstd
  ];

  runtimeLibraryPath = lib.makeLibraryPath [
    pkgs.openssl
    pkgs.postgresql.lib
    pkgs.stdenv.cc.cc.lib
    pkgs.zlib
  ];
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/torghut";
  tag = "nix";
  created = "1970-01-01T00:00:01Z";
  maxLayers = 32;
  contents = [
    appRoot
    pythonDeps
    python
    pkgs.bash
    pkgs.busybox
    pkgs.cacert
    pkgs.coreutils
    pkgs.curl
    pkgs.kubectl
    pkgs.openssl
    pkgs.pigz
    pkgs.postgresql.lib
    pkgs.stdenv.cc.cc.lib
    pkgs.zlib
    pkgs.zstd
  ];
  extraCommands = ''
    mkdir -p tmp var/tmp
    chmod 1777 tmp var/tmp
  '';
  config = {
    Entrypoint = [
      "${pythonDeps}/venv/bin/uvicorn"
      "app.main:app"
      "--host"
      "0.0.0.0"
      "--port"
      "8181"
    ];
    WorkingDir = "/app";
    Env = [
      "PATH=${pythonDeps}/venv/bin:${runtimePath}"
      "LD_LIBRARY_PATH=${runtimeLibraryPath}"
      "PYTHONPATH=/app"
      "PYTHONDONTWRITEBYTECODE=1"
      "PYTHONUNBUFFERED=1"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
    ExposedPorts = {
      "8181/tcp" = { };
    };
    Labels = {
      "org.opencontainers.image.title" = "torghut";
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "proompteng.ai/nix-package-attr" = "torghut-image";
    };
  };
}
