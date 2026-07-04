{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
  exact,
}:

let
  kubectl = exact.kubectl or pkgs.kubectl;
  yq = exact.yq or pkgs.yq;
  natsCliVersion = "0.4.0";
  natsCliArch =
    {
      x86_64-linux = {
        arch = "amd64";
        hash = "sha256-jb1DfIJrlT29dDLPiQ7yK6PDPczD3OXnGz6NBVQnhJw=";
      };
      aarch64-linux = {
        arch = "arm64";
        hash = "sha256-nODIpmU81pfQsyaH/LU7WcE6KtemreevitihwPc1eoc=";
      };
    }
    .${pkgs.stdenv.hostPlatform.system}
      or (throw "NATS CLI is not packaged for ${pkgs.stdenv.hostPlatform.system}");

  natsCli = pkgs.stdenvNoCC.mkDerivation {
    pname = "nats";
    version = natsCliVersion;

    src = pkgs.fetchurl {
      url = "https://github.com/nats-io/natscli/releases/download/v${natsCliVersion}/nats-${natsCliVersion}-linux-${natsCliArch.arch}.zip";
      hash = natsCliArch.hash;
    };

    nativeBuildInputs = [ pkgs.unzip ];
    sourceRoot = ".";
    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 nats-${natsCliVersion}-linux-${natsCliArch.arch}/nats "$out/bin/nats"
      runHook postInstall
    '';
  };

  depsHash = {
    x86_64-linux = "sha256-iddP+lrH0Q/EOtoysehoOu/e3IzE+t9KLvL7f4LTVjI=";
    aarch64-linux = "sha256-uJhRjODpWIn1mYfC6bAkpji4/dfa7RbqRvKMs1wVhPQ=";
  };

  installFilters = [
    "@proompteng/agent-contracts"
    "@proompteng/agents"
    "@proompteng/codex"
    "@proompteng/cx-tools"
    "@proompteng/otel"
    "@proompteng/temporal-bun-sdk"
  ];

  sourcePaths = [
    "charts/agents/crds"
    "packages/agent-contracts"
    "packages/codex"
    "packages/cx-tools"
    "packages/otel"
    "packages/temporal-bun-sdk"
    "services/agents"
  ];

  buildCommands = [
    "bun --cwd=packages/agent-contracts run build"
    "bun --cwd=packages/codex run build"
    "bun --cwd=packages/otel run build"
    "bun --cwd=packages/temporal-bun-sdk run build"
    "bun --cwd=packages/cx-tools run build"
    "bun --cwd=services/agents run tsc"
    "bun --cwd=services/agents run build"
  ];

  runtimeInstallPhase = ''
    mkdir -p "$out/app/packages" "$out/app/services/agents"

    copyWorkspaceNodeModules() {
      local source_path="$1"
      local target_path="$2"

      if [ -d "$source_path" ]; then
        rm -rf "$target_path"
        mkdir -p "$target_path"
        cp -R "$source_path/." "$target_path/"
      fi
    }

    cp -R "$TMPDIR/work/node_modules" "$out/app/node_modules"
    for package in agent-contracts codex cx-tools otel temporal-bun-sdk; do
      cp -R "$TMPDIR/work/packages/$package" "$out/app/packages/$package"
      copyWorkspaceNodeModules "$TMPDIR/work/packages/$package/node_modules" "$out/app/packages/$package/node_modules"
    done

    cp "$TMPDIR/work/services/agents/package.json" "$out/app/services/agents/package.json"
    cp -R "$TMPDIR/work/services/agents/src" "$out/app/services/agents/src"
    cp -R "$TMPDIR/work/services/agents/scripts" "$out/app/services/agents/scripts"
    cp -R "$TMPDIR/work/services/agents/.output" "$out/app/services/agents/.output"
    copyWorkspaceNodeModules "$TMPDIR/work/services/agents/node_modules" "$out/app/services/agents/node_modules"

    chmod +x "$out/app/services/agents/scripts/agents-shell-entrypoint.sh"
    mkdir -p "$out/app/packages/agent-contracts/node_modules"
    rm -rf "$out/app/packages/agent-contracts/node_modules/effect"
    ln -s /app/node_modules/effect "$out/app/packages/agent-contracts/node_modules/effect"
  '';

  scriptWrapper =
    name: target:
    pkgs.writeShellScriptBin name ''
      exec ${bun}/bin/bun ${target} "$@"
    '';

  cxTools = [
    (scriptWrapper "codex-nats-publish" "/app/packages/cx-tools/dist/codex-nats-publish.js")
    (scriptWrapper "codex-nats-soak" "/app/packages/cx-tools/dist/codex-nats-soak.js")
    (scriptWrapper "cx-codex-run" "/app/packages/cx-tools/dist/cx-codex-run.js")
    (scriptWrapper "cx-workflow-cancel" "/app/packages/cx-tools/dist/cx-workflow-cancel.js")
    (scriptWrapper "cx-workflow-query" "/app/packages/cx-tools/dist/cx-workflow-query.js")
    (scriptWrapper "cx-workflow-signal" "/app/packages/cx-tools/dist/cx-workflow-signal.js")
    (scriptWrapper "cx-workflow-start" "/app/packages/cx-tools/dist/cx-workflow-start.js")
  ];

  applyPatch = pkgs.writeShellScriptBin "apply_patch" ''
    exec ${pkgs.python3}/bin/python3 /app/services/agents/scripts/apply_patch.py "$@"
  '';

  commonContents = [
    kubectl
    nodejs
    pkgs.bash
    pkgs.curl
    pkgs.git
    pkgs.jq
    natsCli
    yq
  ] ++ cxTools;

  agentsShellContents = commonContents ++ [
    applyPatch
    pkgs.gh
    pkgs.openssh
    pkgs.procps
    pkgs.python3
    pkgs.ripgrep
    pkgs.uv
    pkgs.wget
  ];

  mkImage =
    {
      serviceName,
      imageName,
      command,
      env,
      extraContents ? commonContents,
      exposedPorts ? { },
    }:
    import ./bun-workspace-service.nix {
      inherit
        pkgs
        lib
        repoRoot
        bun
        nodejs
        depsHash
        installFilters
        sourcePaths
        buildCommands
        runtimeInstallPhase
        command
        env
        extraContents
        exposedPorts
        ;
      depsName = "agents-controller";
      packageName = "@proompteng/agents";
      inherit serviceName imageName;
      dependencyClosure = "bunCache";
      workingDir = "/app/services/agents";
    };
in
{
  "agents-control-plane-image" = mkImage {
    serviceName = "agents-control-plane";
    imageName = "agents-control-plane";
    command = [
      "bun"
      "run"
      "start"
    ];
    env = [
      "AGENTS_CONTROLLER_ENABLED=0"
      "AGENTS_ORCHESTRATION_CONTROLLER_ENABLED=0"
      "AGENTS_SUPPORTING_CONTROLLER_ENABLED=0"
      "AGENTS_AGENT_COMMS_SUBSCRIBER_DISABLED=true"
      "AGENTS_PRIMITIVES_RECONCILER=0"
      "AGENTS_SERVER_PROFILE=agents-control-plane"
      "AGENTS_RUNTIME_SERVICE=agents"
    ];
    exposedPorts = {
      "3000/tcp" = { };
    };
  };

  "agents-controller-image" = mkImage {
    serviceName = "agents-controller";
    imageName = "agents-controller";
    command = [
      "bun"
      "run"
      "src/server/controller-entrypoint.ts"
    ];
    env = [
      "AGENTS_SERVER_PROFILE=agents-controllers"
      "AGENTS_CONTROL_PLANE_CACHE_ENABLED=0"
      "AGENTS_GRPC_ENABLED=0"
      "AGENTS_AGENT_COMMS_SUBSCRIBER_DISABLED=true"
      "AGENTS_RUNTIME_SERVICE=agents"
    ];
  };

  "agents-shell-image" = mkImage {
    serviceName = "agents-shell";
    imageName = "agents-shell";
    command = [
      "bash"
      "./scripts/agents-shell-entrypoint.sh"
    ];
    env = [
      "AGENTS_SERVER_PROFILE=agents-shell"
      "AGENTS_GRPC_ENABLED=0"
      "AGENTS_AGENT_COMMS_SUBSCRIBER_DISABLED=true"
      "AGENTS_RUNTIME_SERVICE=agents-shell"
      "AGENTS_SHELL_WORKSPACE_ROOT=/workspace"
      "AGENTS_SHELL_AUDIT_LOG_PATH=/workspace/.agents-shell/audit.jsonl"
      "AGENTS_SHELL_RESOURCE=https://agents-shell.proompteng.ai"
      "AGENTS_SHELL_OAUTH_ISSUER=https://auth.proompteng.ai/realms/master"
      "AGENTS_SHELL_ALLOWED_K8S_NAMESPACES=agents"
      "HOME=/workspace/.agents-shell/home"
    ];
    extraContents = agentsShellContents;
    exposedPorts = {
      "3000/tcp" = { };
    };
  };
}
