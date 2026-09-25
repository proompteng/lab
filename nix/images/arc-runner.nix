{
  pkgs,
  lib,
  ciToolchain,
}:

let
  system = pkgs.stdenv.hostPlatform.system;
  baseImageHash =
    {
      x86_64-linux = "sha256-b1vS0IDuXoWsoUF1mKgBLc8SncwvtXgIwHkDYGY/TDk=";
      aarch64-linux = "sha256-y0LvyBN6u7W0CC/49uS+0VwNtViKgUW4r9Zp/V842jg=";
    }
    .${system} or (throw "arc-runner-image is not supported on ${system}");

  baseImage = pkgs.dockerTools.pullImage {
    imageName = "ghcr.io/actions/actions-runner";
    imageDigest = "sha256:e5496277be5d09bc968b3d64911b74e219ac4a3f2edce956a3ecf9271bea1ef4";
    hash = baseImageHash;
    finalImageName = "ghcr.io/actions/actions-runner";
    finalImageTag = "pinned";
  };

  imageRoot = pkgs.buildEnv {
    name = "lab-arc-runner-root";
    paths = [
      ciToolchain
      pkgs.bash
      pkgs.cacert
      pkgs.coreutils
    ];
    pathsToLink = [ "/bin" ];
    ignoreCollisions = true;
  };

  toolPath = lib.makeBinPath [
    ciToolchain
    pkgs.bash
    pkgs.coreutils
  ];
in
pkgs.dockerTools.buildLayeredImageWithNixDb {
  name = "registry.ide-newton.ts.net/lab/arc-runner";
  tag = "nix";
  fromImage = baseImage;
  contents = [ imageRoot ];
  uid = 1001;
  gid = 1001;
  created = "1970-01-01T00:00:01Z";
  extraCommands = ''
    mkdir -p \
      etc/nix \
      nix/store \
      nix/var/log/nix/drvs \
      nix/var/nix/db \
      nix/var/nix/gcroots/per-user/runner \
      nix/var/nix/profiles/per-user/runner \
      nix/var/nix/temproots \
      nix/var/nix/userpool \
      tmp \
      var/tmp
    cat > etc/nix/nix.conf <<'EOF'
    experimental-features = nix-command flakes
    fallback = true
    build-users-group =
    EOF
    chmod 0755 nix nix/store nix/var nix/var/log nix/var/log/nix nix/var/log/nix/drvs
    chmod -R u+rwX,go+rX nix/var/nix
    chmod 1777 tmp var/tmp
  '';
  fakeRootCommands = ''
    chown 1001:1001 ./nix ./nix/store ./nix/var ./nix/var/log ./nix/var/log/nix ./nix/var/log/nix/drvs
    chown -R 1001:1001 ./nix/var/nix
  '';
  config = {
    Cmd = [ "/home/runner/run.sh" ];
    Env = [
      "PATH=${toolPath}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
      "HOME=/home/runner"
      "USER=runner"
      "LAB_ARC_RUNNER_TOOLCHAIN=1"
      "NIX_PAGER=cat"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
    Labels = {
      "org.opencontainers.image.title" = "lab-arc-runner";
      "org.opencontainers.image.description" = "GitHub Actions ARC runner with the Lab Nix CI toolchain preinstalled";
      "org.opencontainers.image.source" = "https://github.com/proompteng/lab";
      "proompteng.ai/nix-package-attr" = "arc-runner-image";
    };
    User = "runner";
    WorkingDir = "/home/runner";
  };
}
