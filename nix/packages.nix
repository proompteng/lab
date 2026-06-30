{ pkgs, lib, system }:

let
  fetchurl = pkgs.fetchurl;

  unsupported = name: throw "${name} is not packaged for ${system}";

  sourceFor =
    name: sources:
    sources.${system} or (unsupported name);

  mkTarballBin =
    {
      pname,
      version,
      source,
      installPath ? pname,
      outputName ? pname,
    }:
    pkgs.stdenvNoCC.mkDerivation ({
      inherit pname version;
      src = source.src;
      nativeBuildInputs = [
        pkgs.gnutar
        pkgs.gzip
        pkgs.xz
      ];

      dontConfigure = true;
      dontBuild = true;

      installPhase = ''
        runHook preInstall
        install -Dm755 ${installPath} "$out/bin/${outputName}"
        runHook postInstall
      '';
    } // lib.optionalAttrs (source ? sourceRoot) {
      inherit (source) sourceRoot;
    });

  mkRawBin =
    {
      pname,
      version,
      source,
      outputName ? pname,
    }:
    pkgs.stdenvNoCC.mkDerivation {
      inherit pname version;
      src = source.src;

      dontUnpack = true;
      dontConfigure = true;
      dontBuild = true;

      installPhase = ''
        runHook preInstall
        install -Dm755 "$src" "$out/bin/${outputName}"
        runHook postInstall
      '';
    };

  mkGzipBin =
    {
      pname,
      version,
      source,
      outputName ? pname,
    }:
    pkgs.stdenvNoCC.mkDerivation {
      inherit pname version;
      src = source.src;
      nativeBuildInputs = [ pkgs.gzip ];

      dontUnpack = true;
      dontConfigure = true;
      dontBuild = true;

      installPhase = ''
        runHook preInstall
        gzip -dc "$src" > "${outputName}"
        install -Dm755 "${outputName}" "$out/bin/${outputName}"
        runHook postInstall
      '';
    };

  kustomizeVersion = "5.8.0";
  kustomizeSource = sourceFor "kustomize" {
    x86_64-linux = {
      sourceRoot = ".";
      src = fetchurl {
        url = "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v${kustomizeVersion}/kustomize_v${kustomizeVersion}_linux_amd64.tar.gz";
        hash = "sha256-TfqDBzWN2ShKpNKx1VlnZqZbk0M+j6P590SYlB8Bxe8=";
      };
    };
    aarch64-linux = {
      sourceRoot = ".";
      src = fetchurl {
        url = "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v${kustomizeVersion}/kustomize_v${kustomizeVersion}_linux_arm64.tar.gz";
        hash = "sha256-pPSLTD1MqX10iUPhkWnehaLoboC8wJVYYD4qpm+xXOE=";
      };
    };
    x86_64-darwin = {
      sourceRoot = ".";
      src = fetchurl {
        url = "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v${kustomizeVersion}/kustomize_v${kustomizeVersion}_darwin_amd64.tar.gz";
        hash = "sha256-Leqm+WRQwLMgTMzZ8VmiInjrbPha1UXSEtYI0kKK61c=";
      };
    };
    aarch64-darwin = {
      sourceRoot = ".";
      src = fetchurl {
        url = "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v${kustomizeVersion}/kustomize_v${kustomizeVersion}_darwin_arm64.tar.gz";
        hash = "sha256-0Jj2Ls2lAMdSMDFjg4r4I/lH0kWSfzAAtikZnB7urg8=";
      };
    };
  };

  kubeconformVersion = "0.7.0";
  kubeconformSource = sourceFor "kubeconform" {
    x86_64-linux = {
      sourceRoot = ".";
      src = fetchurl {
        url = "https://github.com/yannh/kubeconform/releases/download/v${kubeconformVersion}/kubeconform-linux-amd64.tar.gz";
        hash = "sha256-wxUY3dEiZjs/Oqh0z+gXjLCYjelE8px0oLkmCSDRFdM=";
      };
    };
    aarch64-linux = {
      sourceRoot = ".";
      src = fetchurl {
        url = "https://github.com/yannh/kubeconform/releases/download/v${kubeconformVersion}/kubeconform-linux-arm64.tar.gz";
        hash = "sha256-zJB8z548NFI/DzK2l0UmXgppCMqFuS9Bkx1FN4YOuDw=";
      };
    };
    x86_64-darwin = {
      sourceRoot = ".";
      src = fetchurl {
        url = "https://github.com/yannh/kubeconform/releases/download/v${kubeconformVersion}/kubeconform-darwin-amd64.tar.gz";
        hash = "sha256-xnccyJTYLhsS817nl9zaH32mo3h6owkCoVwmQFbdQNQ=";
      };
    };
    aarch64-darwin = {
      sourceRoot = ".";
      src = fetchurl {
        url = "https://github.com/yannh/kubeconform/releases/download/v${kubeconformVersion}/kubeconform-darwin-arm64.tar.gz";
        hash = "sha256-tdMrLLd/nHgcl2sgqF4tC8j5GE1dHP5mWi8xoZ+Z7rk=";
      };
    };
  };

  kubectlVersion = "1.29.4";
  kubectlSource = sourceFor "kubectl" {
    x86_64-linux.src = fetchurl {
      url = "https://dl.k8s.io/release/v${kubectlVersion}/bin/linux/amd64/kubectl";
      hash = "sha256-EONDhhw8sAEBYecDMHupB63Sru6v/GREd5rZFfmInIg=";
    };
    aarch64-linux.src = fetchurl {
      url = "https://dl.k8s.io/release/v${kubectlVersion}/bin/linux/arm64/kubectl";
      hash = "sha256-YVN0CO7crQZNczQ4Su1Qioqh6nhjEbh7UFRWouBTXTY=";
    };
    x86_64-darwin.src = fetchurl {
      url = "https://dl.k8s.io/release/v${kubectlVersion}/bin/darwin/amd64/kubectl";
      hash = "sha256-evm4ojPEmtXuy1kARxngvAeXJJK2dOu84pGeUzJrVbI=";
    };
    aarch64-darwin.src = fetchurl {
      url = "https://dl.k8s.io/release/v${kubectlVersion}/bin/darwin/arm64/kubectl";
      hash = "sha256-s6iB5iCKpBJ1qXSBZ2qMijwWKC8817RBsX8ligVAEvE=";
    };
  };

  argoWorkflowsVersion = "4.0.5";
  argoWorkflowsSource = sourceFor "argo-workflows" {
    x86_64-linux.src = fetchurl {
      url = "https://github.com/argoproj/argo-workflows/releases/download/v${argoWorkflowsVersion}/argo-linux-amd64.gz";
      hash = "sha256-hzJBjzvJMOnqDivklycM8kW1XHrJrhFoVnQ/a8MnM8A=";
    };
    aarch64-linux.src = fetchurl {
      url = "https://github.com/argoproj/argo-workflows/releases/download/v${argoWorkflowsVersion}/argo-linux-arm64.gz";
      hash = "sha256-KAaD9NKcQzxhS7xH2GONLKCVqY4VD4IbcaQHMmBuNMs=";
    };
    x86_64-darwin.src = fetchurl {
      url = "https://github.com/argoproj/argo-workflows/releases/download/v${argoWorkflowsVersion}/argo-darwin-amd64.gz";
      hash = "sha256-zztdjIKQLeFj5+85L/vajBdnFiDIInhdFORwVVY+FlQ=";
    };
    aarch64-darwin.src = fetchurl {
      url = "https://github.com/argoproj/argo-workflows/releases/download/v${argoWorkflowsVersion}/argo-darwin-arm64.gz";
      hash = "sha256-/lFleWUZwKS6riwgAQ4LDh3ra6jzycXC7qIb2INJ4Go=";
    };
  };

  shellcheckVersion = "0.11.0";
  shellcheckSource = sourceFor "shellcheck" {
    x86_64-linux = {
      archiveRoot = "shellcheck-v${shellcheckVersion}";
      src = fetchurl {
        url = "https://github.com/koalaman/shellcheck/releases/download/v${shellcheckVersion}/shellcheck-v${shellcheckVersion}.linux.x86_64.tar.xz";
        hash = "sha256-jDvhKwXVwXegTCnjx4zomshvFZVoHKsUm2W5fE4icZg=";
      };
    };
    aarch64-linux = {
      archiveRoot = "shellcheck-v${shellcheckVersion}";
      src = fetchurl {
        url = "https://github.com/koalaman/shellcheck/releases/download/v${shellcheckVersion}/shellcheck-v${shellcheckVersion}.linux.aarch64.tar.xz";
        hash = "sha256-ErMxwdLba56xPPymQwaxsVeobraduDAj4mHqp+fBRYg=";
      };
    };
    x86_64-darwin = {
      archiveRoot = "shellcheck-v${shellcheckVersion}";
      src = fetchurl {
        url = "https://github.com/koalaman/shellcheck/releases/download/v${shellcheckVersion}/shellcheck-v${shellcheckVersion}.darwin.x86_64.tar.xz";
        hash = "sha256-PInbTtyrfPHCe/8XiILg9vJ/ev31ToWfoEH8oQ/r5MY=";
      };
    };
    aarch64-darwin = {
      archiveRoot = "shellcheck-v${shellcheckVersion}";
      src = fetchurl {
        url = "https://github.com/koalaman/shellcheck/releases/download/v${shellcheckVersion}/shellcheck-v${shellcheckVersion}.darwin.aarch64.tar.xz";
        hash = "sha256-Vq/92N5VJ4lNym3D1+Cpmoc7DwBNeqvDCuQH0/SLCnk=";
      };
    };
  };

  yqVersion = "4.49.2";
  yqSource = sourceFor "yq" {
    x86_64-linux.src = fetchurl {
      url = "https://github.com/mikefarah/yq/releases/download/v${yqVersion}/yq_linux_amd64";
      hash = "sha256-viwN3PQmtqIxZIYQ7F0WZq5Q6fZHPoL2SG+fTLbj4vc=";
    };
    aarch64-linux.src = fetchurl {
      url = "https://github.com/mikefarah/yq/releases/download/v${yqVersion}/yq_linux_arm64";
      hash = "sha256-eDqjw77tzyv0qvYmLso4uSoW0+ox4iGMqAuo7HImskg=";
    };
    x86_64-darwin.src = fetchurl {
      url = "https://github.com/mikefarah/yq/releases/download/v${yqVersion}/yq_darwin_amd64";
      hash = "sha256-wUzUrmjUIHTlhGP169vDxJ7CfG3mojtK9YpIO8PxWqA=";
    };
    aarch64-darwin.src = fetchurl {
      url = "https://github.com/mikefarah/yq/releases/download/v${yqVersion}/yq_darwin_arm64";
      hash = "sha256-sLcO3is5K6AgkbgTe0LbgZp5aM8jLVld1zlKxWaLSgs=";
    };
  };

  goVersion = "1.25.5";
  goSource = sourceFor "go" {
    x86_64-linux.src = fetchurl {
      url = "https://go.dev/dl/go${goVersion}.linux-amd64.tar.gz";
      hash = "sha256-npt1XWOzas8wwSqaP8N5JDcUwcbT3XKGHaY38zbrs1s=";
    };
    aarch64-linux.src = fetchurl {
      url = "https://go.dev/dl/go${goVersion}.linux-arm64.tar.gz";
      hash = "sha256-sAtpSQPRJsWIw3jnLTVFVJk105gmNbo/epZMn6I/47k=";
    };
    x86_64-darwin.src = fetchurl {
      url = "https://go.dev/dl/go${goVersion}.darwin-amd64.tar.gz";
      hash = "sha256-tp1RvOWZ5TgalM4VJjrmROyEZnpc4j1Y3C5j4sEqn1Y=";
    };
    aarch64-darwin.src = fetchurl {
      url = "https://go.dev/dl/go${goVersion}.darwin-arm64.tar.gz";
      hash = "sha256-vtjr6CTj07J+hHHRMH+AP8arjh0Ot6SuGWl5vZuAHdM=";
    };
  };

  bunVersion = "1.3.14";
  bunSource = sourceFor "bun" {
    x86_64-linux = {
      sourceRoot = "bun-linux-x64";
      src = fetchurl {
        url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-x64.zip";
        hash = "sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=";
      };
    };
    aarch64-linux = {
      sourceRoot = "bun-linux-aarch64";
      src = fetchurl {
        url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-aarch64.zip";
        hash = "sha256-on/7Y6gxA3WDbg1vZorhf6jY0YuIw3yCHGUzGXOhmjs=";
      };
    };
    x86_64-darwin = {
      sourceRoot = "bun-darwin-x64-baseline";
      src = fetchurl {
        url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-darwin-x64-baseline.zip";
        hash = "sha256-PjWtb1OXGpg0v55nhuKt9ytfGSHMmpxf3gc9KXKUQHY=";
      };
    };
    aarch64-darwin = {
      sourceRoot = "bun-darwin-aarch64";
      src = fetchurl {
        url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-darwin-aarch64.zip";
        hash = "sha256-2LliIYKK1vl6x6wKt+lYcjQa92MAHogD6CZ2UsJlJiA=";
      };
    };
  };

  bun = pkgs.stdenvNoCC.mkDerivation {
    pname = "bun";
    version = bunVersion;
    src = bunSource.src;
    sourceRoot = bunSource.sourceRoot;

    strictDeps = true;
    nativeBuildInputs = [ pkgs.unzip ] ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [
      pkgs.autoPatchelfHook
    ];
    buildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [
      pkgs.openssl
      pkgs.stdenv.cc.cc.lib
      pkgs.zlib
    ];

    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 ./bun "$out/bin/bun"
      ln -s "$out/bin/bun" "$out/bin/bunx"
      runHook postInstall
    '';
  };

in
{
  inherit bun;

  helm =
    let
      helm = pkgs.kubernetes-helm;
      major = lib.versions.major (lib.getVersion helm);
    in
    if major == "3" then
      helm
    else
      throw "kubernetes-helm must stay on Helm 3, got ${lib.getVersion helm}";

  kustomize = mkTarballBin {
    pname = "kustomize";
    version = kustomizeVersion;
    source = kustomizeSource;
  };

  kubeconform = mkTarballBin {
    pname = "kubeconform";
    version = kubeconformVersion;
    source = kubeconformSource;
  };

  kubectl = mkRawBin {
    pname = "kubectl";
    version = kubectlVersion;
    source = kubectlSource;
  };

  argo-workflows = mkGzipBin {
    pname = "argo-workflows";
    version = argoWorkflowsVersion;
    source = argoWorkflowsSource;
    outputName = "argo";
  };

  shellcheck = mkTarballBin {
    pname = "shellcheck";
    version = shellcheckVersion;
    source = shellcheckSource;
    installPath = "shellcheck";
  };

  yq = mkRawBin {
    pname = "yq";
    version = yqVersion;
    source = yqSource;
  };

  go = pkgs.stdenvNoCC.mkDerivation {
    pname = "go";
    version = goVersion;
    src = goSource.src;
    sourceRoot = "go";

    nativeBuildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [
      pkgs.autoPatchelfHook
    ];
    buildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [
      pkgs.stdenv.cc.cc.lib
    ];
    autoPatchelfIgnoreMissingDeps = [
      # Go ships ELF fixtures in src/debug testdata. They are not executed by
      # the dev shell, but auto-patchelf still sees their shared-library names.
      "libtiff.so.6"
    ];

    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall
      mkdir -p "$out/share/go" "$out/bin"
      cp -R . "$out/share/go"
      ln -s "$out/share/go/bin/go" "$out/bin/go"
      ln -s "$out/share/go/bin/gofmt" "$out/bin/gofmt"
      runHook postInstall
    '';
  };
}
