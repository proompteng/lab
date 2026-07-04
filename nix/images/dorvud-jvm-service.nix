{
  pkgs,
  lib,
  repoRoot,
  serviceName,
  imageName ? serviceName,
  gradleProject,
  gradleTask ? "installDist",
  mainClass,
  copyInstallDist ? true,
  maxLayers ? 24,
}:

let
  dorvudRoot = repoRoot + "/services/dorvud";
  dorvudRootString = toString dorvudRoot;
  jre = pkgs.temurin-jre-bin-21;

  relativePath =
    path:
    let
      pathString = toString path;
      prefix = "${dorvudRootString}/";
    in
    if pathString == dorvudRootString then "" else lib.removePrefix prefix pathString;

  modulePrefixes = [
    "flink-integration"
    "hyperliquid-feed"
    "platform"
    "technical-analysis"
    "technical-analysis-flink"
    "websockets"
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

  appRoot = pkgs.stdenvNoCC.mkDerivation {
    pname = "${serviceName}-gradle-runtime-root";
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

      gradle --no-daemon --project-cache-dir "$TMPDIR/gradle-project-cache" :${gradleProject}:${gradleTask}

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/app"
      ${
        if copyInstallDist then
          ''
            cp -R ${gradleProject}/build/install/${gradleProject}/. "$out/app/"
            test -d "$out/app/lib"
          ''
        else
          ''
            cp ${gradleProject}/build/libs/${gradleProject}-all.jar "$out/app/app.jar"
            test -f "$out/app/app.jar"
          ''
      }
      find "$out" -name '*.bat' -delete

      runHook postInstall
    '';
  };

  runtimePath = lib.makeBinPath [
    jre
    pkgs.busybox
    pkgs.coreutils
  ];
in
pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/${imageName}";
  tag = "nix";
  inherit maxLayers;
  created = "1970-01-01T00:00:01Z";
  contents = [
    appRoot
    jre
    pkgs.busybox
    pkgs.cacert
    pkgs.coreutils
  ];
  extraCommands = ''
    mkdir -p tmp var/tmp
    chmod 1777 tmp var/tmp
  '';
  config = {
    Entrypoint =
      if copyInstallDist then
        [
          "${jre}/bin/java"
          "-cp"
          "/app/lib/*"
          mainClass
        ]
      else
        [
          "${jre}/bin/java"
          "-jar"
          "/app/app.jar"
        ];
    WorkingDir = "/app";
    User = "65532:65532";
    Env = [
      "PATH=${runtimePath}"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "JAVA_TOOL_OPTIONS=-XX:+UseContainerSupport -XX:InitialRAMPercentage=40.0 -XX:MaxRAMPercentage=70.0 -XX:+ExitOnOutOfMemoryError"
      "HOME=/tmp"
    ];
    ExposedPorts = {
      "8080/tcp" = { };
      "9090/tcp" = { };
    };
    Labels = {
      "org.opencontainers.image.title" = serviceName;
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "proompteng.ai/nix-package-attr" = "${imageName}-image";
    };
  };
}
