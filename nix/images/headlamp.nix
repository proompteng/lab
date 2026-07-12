{
  pkgs,
  lib,
  repoRevision ? "dirty",
}:

let
  version = "0.40.1";
  headlampSha = "434a12263a6bd9d25f86f8bfa00d9992ac2672e3";

  upstreamSrc = pkgs.fetchFromGitHub {
    owner = "kubernetes-sigs";
    repo = "headlamp";
    rev = headlampSha;
    hash = "sha256-pqaEwbMC8zMMs9gy078iJrvuGqGbvT3OMuvI5kmVBik=";
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

  backend = pkgs.buildGoModule {
    pname = "headlamp-backend";
    inherit version;
    src = patchedSrc;
    modRoot = "backend";
    vendorHash = "sha256-0r2PsQLSny+I7QBo91Jhz/S5Sx5VluOPZC7tV1K/oQM=";
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
    npmDepsHash = "sha256-vJiAqhwiyfEGWUap1dg4LrY2RnOOEHbt6wp/rUcsXDg=";
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
    version = "0.8.2";
    src = pkgs.fetchurl {
      url = "https://github.com/headlamp-k8s/plugins/releases/download/prometheus-0.8.2/prometheus-0.8.2.tar.gz";
      hash = "sha256-EoAXKGioHnP1N+ulXcDcdl3vpQFCuTEgCMK65wKjx6g=";
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
    runtimeRoot
    pkgs.busybox
    pkgs.cacert
  ];
  extraCommands = ''
    mkdir -p tmp var/tmp etc/ssl/certs
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
