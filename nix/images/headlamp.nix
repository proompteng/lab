{
  pkgs,
  lib,
  repoRevision ? "dirty",
}:

let
  version = "0.44.0";
  headlampSha = "7e2f255cc256a16c39681ffea31fa16e11a11eaf";
  headlampNixpkgsRevision = "104240a772428cc2e20d8fd86c9ddbb886bbaff2";

  headlampNixpkgs = builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/${headlampNixpkgsRevision}.tar.gz";
    sha256 = "sha256-D740uKsMbgsfK2oaDenJLLPIZfq7W0/g4KN/Fls8eKs=";
  };
  headlampPkgs = import headlampNixpkgs {
    system = pkgs.stdenv.hostPlatform.system;
    config.allowUnfree = false;
  };
  headlampGo =
    if headlampPkgs.go.version == "1.26.5" then
      headlampPkgs.go
    else
      throw "expected Headlamp Go 1.26.5, got ${headlampPkgs.go.version}";
  headlampBuildGoModule = headlampPkgs.buildGoModule.override { go = headlampGo; };

  upstreamSrc = pkgs.fetchFromGitHub {
    owner = "kubernetes-sigs";
    repo = "headlamp";
    rev = headlampSha;
    hash = "sha256-ajkiKoCYbwn5pvIzzz4IIxWIVQmnTbNvzdwWksj1kEU=";
  };

  patchedSrc = pkgs.stdenvNoCC.mkDerivation {
    pname = "headlamp-patched-source";
    inherit version;
    src = upstreamSrc;
    patches = [
      ../../services/headlamp/patches/0001-multiplexer-http-watch-stream.patch
      ../../services/headlamp/patches/0002-multiplexer-auth-cookie-scope.patch
      ../../services/headlamp/patches/0003-oidc-refresh-reauth.patch
      ../../services/headlamp/patches/0004-static-copy-writable.patch
    ];
    nativeBuildInputs = [
      pkgs.gnused
    ];
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;
    postPatch = ''
      substituteInPlace frontend/make-env.js \
        --replace-fail \
          "const appInfo = JSON.parse(fs.readFileSync('../app/package.json', 'utf8'));" \
          "const appInfo = { version: '${version}', productName: 'Headlamp' };" \
        --replace-fail \
          "const gitVersion = execSync('git rev-parse HEAD').toString().trim();" \
          "const gitVersion = '${headlampSha}';"
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -R . "$out/"
      runHook postInstall
    '';
  };

  backend = headlampBuildGoModule {
    pname = "headlamp-backend";
    inherit version;
    src = patchedSrc;
    modRoot = "backend";
    vendorHash = "sha256-5nh4IxYr3wdXA8WLlK8LVCm4DqHFB4r+fA+Ix0e5EAc=";
    subPackages = [ "cmd" ];
    doCheck = false;
    env.CGO_ENABLED = 0;
    preBuild = ''
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
    '';
    postInstall = ''
      if [ -x "$out/bin/cmd" ]; then
        mv "$out/bin/cmd" "$out/bin/headlamp-server"
      fi
    '';
  };

  buildNpmPackage = pkgs.buildNpmPackage.override {
    nodejs = pkgs.nodejs_22;
  };

  frontend = buildNpmPackage {
    pname = "headlamp-frontend";
    inherit version;
    src = patchedSrc + "/frontend";
    npmDepsHash = "sha256-VcwKNpHjQlpeDxqhDxNZnTt0BaUPHWZUivU4kqSi6yw=";
    makeCacheWritable = false;
    env = {
      NODE_OPTIONS = "--max-old-space-size=8096";
      REACT_APP_ENABLE_WEBSOCKET_MULTIPLEXER = "true";
    };
    preBuild = ''
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/frontend"
      cp -R build/. "$out/frontend/"
      runHook postInstall
    '';
  };

  prometheusPlugin = pkgs.stdenvNoCC.mkDerivation {
    pname = "headlamp-plugin-prometheus";
    version = "0.9.1";
    src = pkgs.fetchurl {
      url = "https://github.com/headlamp-k8s/plugins/releases/download/prometheus-0.9.1/prometheus-0.9.1.tar.gz";
      hash = "sha256-Bq+r5C2mno4MXCYyrMP+4CBWaCXSrnH/jk891/ePxK4=";
    };
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/static-plugins/prometheus"
      cp main.js package.json "$out/static-plugins/prometheus/"
      runHook postInstall
    '';
  };

  runtimeRoot = pkgs.stdenvNoCC.mkDerivation {
    pname = "headlamp-runtime-root";
    inherit version;
    dontUnpack = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/headlamp/plugins" "$out/headlamp/static-plugins"
      cp ${backend}/bin/headlamp-server "$out/headlamp/headlamp-server"
      cp -R ${frontend}/frontend "$out/headlamp/frontend"
      cp -R ${prometheusPlugin}/static-plugins/. "$out/headlamp/static-plugins/"
      runHook postInstall
    '';
  };
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/headlamp";
  tag = "nix";
  maxLayers = 16;
  contents = [
    pkgs.busybox
    pkgs.cacert
  ];
  extraCommands = ''
    mkdir -p headlamp tmp var/tmp etc/ssl/certs
    # dockerTools materializes `contents` as store-backed symlinks. Headlamp
    # 0.44 serves static files through os.OpenRoot, which rejects symlinks that
    # escape the frontend root. Copy with dereferencing into this image layer.
    cp -RL ${runtimeRoot}/headlamp/. headlamp/
    remaining_headlamp_link="$(find headlamp -type l -print -quit)"
    if [ -n "$remaining_headlamp_link" ]; then
      echo "Headlamp runtime contains an unresolved symlink: $remaining_headlamp_link" >&2
      exit 1
    fi
    chmod 1777 tmp var/tmp
    ln -s ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt etc/ssl/certs/ca-certificates.crt
  '';
  config = {
    Entrypoint = [
      "/headlamp/headlamp-server"
      "-html-static-dir"
      "/headlamp/frontend"
      "-plugins-dir"
      "/headlamp/plugins"
    ];
    Env = [
      "PATH=${lib.makeBinPath [ pkgs.busybox ]}"
      "HOME=/tmp"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "HEADLAMP_STATIC_PLUGINS_DIR=/headlamp/static-plugins"
    ];
    ExposedPorts = {
      "4466/tcp" = { };
    };
    User = "65532:65532";
    Labels = {
      "org.opencontainers.image.title" = "headlamp";
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "org.opencontainers.image.revision" = repoRevision;
      "org.opencontainers.image.version" = "v${version}";
      "headlamp.proompteng.ai/upstream-sha" = headlampSha;
      "proompteng.ai/nix-package-attr" = "headlamp-image";
    };
  };
}
