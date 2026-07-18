{
  pkgs,
  lib,
  repoRoot,
  repoRevision,
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
    filter =
      path: type:
      type == "directory"
      || builtins.elem (relativePath path) [
        "pyproject.toml"
        "uv.lock"
      ];
  };

  runtimeSource = lib.cleanSourceWith {
    src = torghutRoot;
    filter =
      path: type:
      let
        rel = relativePath path;
      in
      type == "directory"
      || builtins.elem rel [
        "app/__init__.py"
        "notebooks/00-system-flow.ipynb"
        "notebooks/10-strategy-lifecycle.ipynb"
        "notebooks/20-execution-evidence.ipynb"
        "notebooks/30-capital-authority.ipynb"
      ]
      || lib.hasPrefix "app/notebook_data/" rel;
  };

  pythonDeps = pkgs.stdenv.mkDerivation {
    pname = "torghut-notebook-python-deps";
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

      export HOME="$TMPDIR/torghut-notebook-home"
      export UV_CACHE_DIR="$TMPDIR/torghut-notebook-uv-cache"
      export UV_LINK_MODE=copy
      export UV_PROJECT_ENVIRONMENT="$out/venv"
      mkdir -p "$HOME" "$UV_CACHE_DIR"

      uv sync \
        --frozen \
        --only-group notebook-runtime \
        --no-install-project \
        --python ${python}/bin/python3.11

      find "$out" -name __pycache__ -type d -prune -exec rm -rf {} +
      find "$out" -name '*.pyc' -delete

      runHook postInstall
    '';
  };

  notebookRoot = pkgs.stdenvNoCC.mkDerivation {
    pname = "torghut-notebook-runtime-root";
    version = "0";
    src = runtimeSource;

    nativeBuildInputs = [ pkgs.coreutils ];
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;

    installPhase = ''
      runHook preInstall
      mkdir -p "$out/opt/torghut/app" "$out/opt/torghut-notebooks"
      cp app/__init__.py "$out/opt/torghut/app/__init__.py"
      cp -R app/notebook_data "$out/opt/torghut/app/notebook_data"
      cp notebooks/00-system-flow.ipynb "$out/opt/torghut-notebooks/"
      cp notebooks/10-strategy-lifecycle.ipynb "$out/opt/torghut-notebooks/"
      cp notebooks/20-execution-evidence.ipynb "$out/opt/torghut-notebooks/"
      cp notebooks/30-capital-authority.ipynb "$out/opt/torghut-notebooks/"
      runHook postInstall
    '';
  };

  startNotebook = pkgs.writeShellApplication {
    name = "start-torghut-notebook";
    runtimeInputs = [
      pkgs.bash
      pkgs.coreutils
    ];
    text = builtins.readFile ../../services/torghut/scripts/start_torghut_notebook.sh;
  };

  runtimePath = lib.makeBinPath [
    python
    pkgs.bash
    pkgs.coreutils
  ];

  runtimeLibraryPath = lib.makeLibraryPath [
    pkgs.openssl
    pkgs.postgresql.lib
    pkgs.stdenv.cc.cc.lib
    pkgs.zlib
  ];
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/torghut-notebook";
  tag = "nix";
  created = "1970-01-01T00:00:01Z";
  maxLayers = 32;
  contents = [
    notebookRoot
    pythonDeps
    startNotebook
    python
    pkgs.bash
    pkgs.cacert
    pkgs.coreutils
    pkgs.openssl
    pkgs.postgresql.lib
    pkgs.stdenv.cc.cc.lib
    pkgs.zlib
  ];
  extraCommands = ''
    mkdir -p etc home/jovyan tmp var/tmp
    echo 'jovyan:x:1000:100:Torghut Notebook:/home/jovyan:/bin/bash' > etc/passwd
    echo 'users:x:100:jovyan' > etc/group
    chown 1000:100 home/jovyan
    chmod 0750 home/jovyan
    chmod 1777 tmp var/tmp
  '';
  config = {
    Entrypoint = [ "${startNotebook}/bin/start-torghut-notebook" ];
    WorkingDir = "/home/jovyan";
    User = "1000:100";
    Env = [
      "PATH=${pythonDeps}/venv/bin:${runtimePath}"
      "LD_LIBRARY_PATH=${runtimeLibraryPath}"
      "PYTHONPATH=/opt/torghut"
      "PYTHONDONTWRITEBYTECODE=1"
      "PYTHONUNBUFFERED=1"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "TORGHUT_NOTEBOOK_GIT_REVISION=${repoRevision}"
    ];
    ExposedPorts = {
      "8888/tcp" = { };
    };
    Labels = {
      "org.opencontainers.image.title" = "torghut-notebook";
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "org.opencontainers.image.revision" = repoRevision;
      "proompteng.ai/nix-package-attr" = "torghut-notebook-image";
    };
  };
}
