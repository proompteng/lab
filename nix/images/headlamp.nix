{
  pkgs,
  lib,
  repoRevision ? "dirty",
}:

let
  version = "0.46.0";
  headlampSha = "825604fdadbe7ed94b8e61f615d7917c743e9083";
  goVersion = "1.26.8";
  goPlatform = {
    x86_64-linux = {
      arch = "amd64";
      hash = "sha256-0PdDsz6NiUXmsfQy7dFXhccFBxIdbipyOyEoXt34tXs=";
    };
    aarch64-linux = {
      arch = "arm64";
      hash = "sha256-IR/87Z3LljOlXqxjZIFuwN3ZUTiadA6I+oszN5cb3aA=";
    };
  }.${pkgs.stdenv.hostPlatform.system};
  headlampGo = pkgs.stdenvNoCC.mkDerivation {
    pname = "go";
    version = goVersion;
    src = pkgs.fetchurl {
      url = "https://go.dev/dl/go${goVersion}.linux-${goPlatform.arch}.tar.gz";
      inherit (goPlatform) hash;
    };
    sourceRoot = "go";
    passthru = {
      GOOS = "linux";
      GOARCH = goPlatform.arch;
      CGO_ENABLED = 0;
    };
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -R . "$out/"
      runHook postInstall
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      test "$("$out/bin/go" env GOVERSION)" = "go${goVersion}"
      runHook postInstallCheck
    '';
  };
  headlampBuildGoModule = pkgs.buildGoModule.override { go = headlampGo; };

  upstreamSrc = pkgs.fetchFromGitHub {
    owner = "kubernetes-sigs";
    repo = "headlamp";
    rev = headlampSha;
    hash = "sha256-chDlfZvfXXaKrY4k1xQ4EO+J0KY4J/kBoYInytIECmk=";
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
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;
    nativeBuildInputs = [ pkgs.jq ];
    postPatch = ''
      # The upstream lock omits registry URLs for some entries with integrity
      # hashes. Restore the URLs so the Nix cache can fetch the locked tarballs.
      jq '
        .packages |= with_entries(
          if .key != "" and .value.resolved == null and .value.integrity != null then
            (.value.name // (.key | split("node_modules/") | last)) as $package
            | ($package | split("/") | last) as $filename
            | .value.resolved = "https://registry.npmjs.org/\($package)/-/\($filename)-\(.value.version).tgz"
          else . end
        )
      ' frontend/package-lock.json > frontend/package-lock.resolved.json
      mv frontend/package-lock.resolved.json frontend/package-lock.json
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
    vendorHash = "sha256-of7baM59Kqm77YpAgK1XM95b/LnctUlKqwXAdMvG8d4=";
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
    npmDepsHash = "sha256-dYFEu5KA3dBVqyD3PKjqqnJ1NcUPDNoiIryzGeoEgLI=";
    makeCacheWritable = false;
    env = {
      NODE_OPTIONS = "--max-old-space-size=8096";
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
      HEADLAMP_SOURCE_COMMIT = headlampSha;
      REACT_APP_ENABLE_WEBSOCKET_MULTIPLEXER = "true";
    };
    preBuild = ''
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
      mkdir -p ../app
      cp ${patchedSrc}/app/package.json ${patchedSrc}/app/app-build-manifest.json ../app/
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
    # 0.45 serves static files through os.OpenRoot, which rejects symlinks that
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
