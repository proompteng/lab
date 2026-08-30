{
  pkgs,
  lib,
  repoRoot,
}:

let
  dorvudRoot = repoRoot + "/services/dorvud";
  dorvudRootString = toString dorvudRoot;

  relativePath =
    path:
    let
      pathString = toString path;
      prefix = "${dorvudRootString}/";
    in
    if pathString == dorvudRootString then "" else lib.removePrefix prefix pathString;

  modulePrefixes = [
    "platform"
    "technical-analysis"
    "technical-analysis-flink"
  ];

  source = lib.cleanSourceWith {
    src = dorvudRoot;
    filter = path: type:
      let
        rel = relativePath path;
      in
      type == "directory"
      || builtins.elem rel [
        "build.gradle.kts"
        "gradle.properties"
        "gradlew"
        "settings.gradle.kts"
      ]
      || lib.hasPrefix "gradle/" rel
      || lib.any (prefix: lib.hasPrefix "${prefix}/" rel) modulePrefixes;
  };

  appJar = pkgs.stdenvNoCC.mkDerivation {
    pname = "torghut-ta-flink-jar";
    version = "0";
    src = source;

    nativeBuildInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.findutils
      pkgs.gradle_9
      pkgs.jdk21_headless
    ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      runHook preBuild

      export GRADLE_USER_HOME="$TMPDIR/gradle-home"
      export JAVA_HOME=${pkgs.jdk21_headless}
      mkdir -p "$GRADLE_USER_HOME"

      gradle --no-daemon --project-cache-dir "$TMPDIR/gradle-project-cache" :technical-analysis-flink:uberJar

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp technical-analysis-flink/build/libs/technical-analysis-flink-all.jar "$out/app.jar"
      test -f "$out/app.jar"
      runHook postInstall
    '';
  };

  flinkBaseBySystem = {
    x86_64-linux = {
      arch = "amd64";
      imageDigest = "sha256:d357b0e1eb89eb4377735a008dfcbd35f7f06af6cba24dfbb6062379fb70a9a9";
      hash = "sha256-yqnR8f52GZMBKohYP63iSwEi1HoFqJjA9aZLnnOiE4I=";
      finalImageTag = "2.0.1-scala_2.12-java21-amd64";
    };
    aarch64-linux = {
      arch = "arm64";
      imageDigest = "sha256:c0b3512ea891d604c585d3cb217b75a2bf920d9faaa9f0770496476189d5f57f";
      hash = "sha256-US/1mivd9zMNrd3Mt98WqwLFHNNse3McFswww8Dn3Ko=";
      finalImageTag = "2.0.1-scala_2.12-java21-arm64";
    };
  };
  flinkBaseSpec =
    flinkBaseBySystem.${pkgs.stdenv.hostPlatform.system}
      or (throw "torghut-ta-image is only supported on x86_64-linux and aarch64-linux");
  flinkBaseImage = pkgs.dockerTools.pullImage {
    imageName = "mirror.gcr.io/flink";
    imageDigest = flinkBaseSpec.imageDigest;
    hash = flinkBaseSpec.hash;
    arch = flinkBaseSpec.arch;
    finalImageName = "mirror.gcr.io/flink";
    finalImageTag = flinkBaseSpec.finalImageTag;
  };

  s3Plugin = pkgs.fetchurl {
    url = "https://repo1.maven.org/maven2/org/apache/flink/flink-s3-fs-hadoop/2.0.1/flink-s3-fs-hadoop-2.0.1.jar";
    hash = "sha256-OMqbSzN4oZd+RaNUA7dmfiWn9kHoJXi7hBtUT8HYsbU=";
  };

  appLayer = pkgs.stdenvNoCC.mkDerivation {
    pname = "torghut-ta-flink-app-layer";
    version = "0";

    nativeBuildInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.findutils
    ];

    dontUnpack = true;
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/opt/flink/usrlib" "$out/opt/flink/plugins/s3-fs-hadoop"
      cp ${appJar}/app.jar "$out/opt/flink/usrlib/app.jar"
      cp ${s3Plugin} "$out/opt/flink/plugins/s3-fs-hadoop/flink-s3-fs-hadoop-2.0.1.jar"

      runHook postInstall
    '';
  };
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/torghut-ta";
  tag = "nix";
  fromImage = flinkBaseImage;
  created = "1970-01-01T00:00:01Z";
  maxLayers = 32;
  contents = [ appLayer ];
  extraCommands = ''
    mkdir -p tmp var/tmp
    chmod 1777 tmp var/tmp
  '';
  config = {
    Entrypoint = [ "/docker-entrypoint.sh" ];
    Cmd = [ "help" ];
    WorkingDir = "/opt/flink";
    Env = [
      "TORGHUT_TA_VERSION=nix"
      "TORGHUT_TA_COMMIT=nix"
    ];
    Labels = {
      "org.opencontainers.image.title" = "torghut-ta";
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "proompteng.ai/nix-package-attr" = "torghut-ta-image";
    };
  };
}
