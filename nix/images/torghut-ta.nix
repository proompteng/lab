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
    filter =
      path: type:
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
      imageDigest = "sha256:dbbc4a0745fbcbf87a3d0d772f50127920e3220779ce2b9ae0179e6ee7a44cca";
      hash = "sha256-J/lYUAuLFoHz3fbW6rAvqLJ3uvoiYxvf6d0XEdMSmCA=";
      finalImageTag = "2.2.1-scala_2.12-java21-amd64";
    };
    aarch64-linux = {
      arch = "arm64";
      imageDigest = "sha256:ff1d667c4c13912fe89c3a5365e72c6faabe44d1a9cc9f41025989833b1c4d2c";
      hash = "sha256-gGRPMhCWhDRPgRE6lrQoS9A7vdrMZPbkyw8eBDuJAVY=";
      finalImageTag = "2.2.1-scala_2.12-java21-arm64";
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
    url = "https://repo1.maven.org/maven2/org/apache/flink/flink-s3-fs-hadoop/2.2.1/flink-s3-fs-hadoop-2.2.1.jar";
    hash = "sha256-8af4ZH3j96wsRnf5uiIco+0y6VQfYZZ9pEXDaq3K+Sc=";
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
      cp ${s3Plugin} "$out/opt/flink/plugins/s3-fs-hadoop/flink-s3-fs-hadoop-2.2.1.jar"

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
