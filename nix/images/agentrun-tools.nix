{ pkgs, lib }:

let
  playwrightVersion = "1.59.1";
  platform = {
    x86_64-linux = {
      browserUrl = "https://storage.googleapis.com/chrome-for-testing-public/147.0.7727.15/linux64/chrome-headless-shell-linux64.zip";
      browserHash = "sha256-z3ec1UhvP8Whi+pKxgYCahZnrhbvruFa9RvTrTrgEJI=";
      spicedbArch = "amd64";
      spicedbHash = "sha256-SQ3S+Rte86evq2AJSfYFo9tNcuqjTotBcrOPINGj5Hc=";
    };
    aarch64-linux = {
      browserUrl = "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1217/chromium-headless-shell-linux-arm64.zip";
      browserHash = "sha256-bbcEHYonMJO48senM4dmxtEquwbNAlP8kf7rtx7NRjU=";
      spicedbArch = "arm64";
      spicedbHash = "sha256-CVw5xYoOQzjba3+nhc6OJDGpB1nfT3zwTXwPtC8/coE=";
    };
  }.${pkgs.stdenv.hostPlatform.system};

  fontConfig = pkgs.makeFontsConf {
    fontDirectories = [ pkgs.dejavu_fonts pkgs.liberation_ttf pkgs.noto-fonts-color-emoji ];
  };

  browser = pkgs.stdenv.mkDerivation {
    pname = "agentrun-chromium-headless-shell";
    version = "147.0.7727.15";
    src = pkgs.fetchurl { url = platform.browserUrl; hash = platform.browserHash; };
    nativeBuildInputs = [ pkgs.unzip pkgs.autoPatchelfHook pkgs.makeWrapper ];
    buildInputs = with pkgs; [
      glib nss nspr dbus atk at-spi2-atk cups libdrm expat libxkbcommon
      xorg.libX11 xorg.libXcomposite xorg.libXdamage xorg.libXext xorg.libXfixes
      xorg.libXrandr xorg.libxcb xorg.libxshmfence mesa pango cairo alsa-lib
      systemd fontconfig freetype vulkan-loader stdenv.cc.cc.lib
    ];
    unpackPhase = ''unzip -q "$src"'';
    dontBuild = true;
    installPhase = ''
      target="$out/opt/playwright-browsers/chromium_headless_shell-1217"
      mkdir -p "$target" "$out/bin"
      cp -R ./* "$target/"
      executable="$(find "$target" -type f \( -name headless_shell -o -name chrome-headless-shell \) | head -n 1)"
      test -n "$executable"
      chmod +x "$executable"
      makeWrapper "$executable" "$out/bin/agentrun-chromium" \
        --set FONTCONFIG_FILE ${fontConfig}
      touch "$target/INSTALLATION_COMPLETE"
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      "$out/bin/agentrun-chromium" --headless --no-sandbox --disable-gpu \
        --disable-dev-shm-usage --dump-dom 'data:text/html,<title>agentrun-browser-ok</title>' \
        | grep -F agentrun-browser-ok
    '';
  };

  spicedb = pkgs.stdenvNoCC.mkDerivation {
    pname = "agentrun-spicedb";
    version = "1.56.2";
    src = pkgs.fetchurl {
      url = "https://github.com/authzed/spicedb/releases/download/v1.56.2/spicedb_1.56.2_linux_${platform.spicedbArch}.tar.gz";
      hash = platform.spicedbHash;
    };
    sourceRoot = ".";
    dontBuild = true;
    installPhase = ''
      install -Dm755 spicedb "$out/bin/spicedb"
      "$out/bin/spicedb" version | grep -F 1.56.2
    '';
  };

  postgres = pkgs.postgresql_18.overrideAttrs (_: {
    version = "18.6";
    src = pkgs.fetchurl {
      url = "https://ftp.postgresql.org/pub/source/v18.6/postgresql-18.6.tar.bz2";
      hash = "sha256-VVYQwk1T5DFtpbfT/CXCedloVtXg4j7jCMMoxfqIHZ8=";
    };
  });
in
{
  inherit browser fontConfig postgres spicedb playwrightVersion;
  contents = with pkgs; [
    browser postgres spicedb openssl util-linux ripgrep buf rustc cargo rustfmt clippy
    stdenv.cc pkg-config cmake protobuf gnumake gnugrep gnused gnutar gzip unzip
    file which
  ];
}
