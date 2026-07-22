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
  pythonPackages = pkgs.python312Packages;
  openaiCodexCli = import ./openai-codex-cli.nix { inherit pkgs; };

  mkPyWheel =
    {
      pname,
      pypiPname ? pname,
      version,
      hash,
      url ? null,
      dist ? "py3",
      python ? "py3",
      propagatedBuildInputs ? [ ],
      pythonImportsCheck ? [ ],
    }:
    pythonPackages.buildPythonPackage {
      inherit
        pname
        version
        propagatedBuildInputs
        pythonImportsCheck
        ;
      format = "wheel";
      src =
        if url == null then
          pkgs.fetchPypi {
            pname = pypiPname;
            inherit version dist python hash;
            format = "wheel";
          }
        else
          pkgs.fetchurl { inherit url hash; };
      doCheck = false;
    };

  dotenv = mkPyWheel {
    pname = "dotenv";
    version = "0.9.9";
    url = "https://files.pythonhosted.org/packages/b2/b7/545d2c10c1fc15e48653c91efde329a790f2eecfbbf2bd16003b5db2bab0/dotenv-0.9.9-py2.py3-none-any.whl";
    hash = "sha256-Kc90oIezHa/bWkRrbX4Ry86O0nQVQOIznGn775LJTOk=";
    python = "py2.py3";
    propagatedBuildInputs = [ pythonPackages."python-dotenv" ];
    pythonImportsCheck = [ "dotenv" ];
  };

  pyluach = mkPyWheel {
    pname = "pyluach";
    version = "2.3.0";
    hash = "sha256-RJe3Ma71lQiwedv18AvFv0MprEUJCmzTe1qDdW8Oaas=";
    pythonImportsCheck = [ "pyluach" ];
  };

  exchangeCalendars = mkPyWheel {
    pname = "exchange-calendars";
    pypiPname = "exchange_calendars";
    version = "4.13.2";
    hash = "sha256-/Foq0NYbXDplOaMGHNTLtVxZ9KkDRVzseSbkt5iRmZY=";
    propagatedBuildInputs = [
      pythonPackages."korean-lunar-calendar"
      pythonPackages.numpy
      pythonPackages.pandas
      pyluach
      pythonPackages.toolz
      pythonPackages.tzdata
    ];
    pythonImportsCheck = [ "exchange_calendars" ];
  };

  pandasTaClassic = mkPyWheel {
    pname = "pandas-ta-classic";
    pypiPname = "pandas_ta_classic";
    version = "0.6.52";
    hash = "sha256-U5Vt3olpuKGsHNp+5RTHS0r2XYAjhzU4FIFKwuHZSeI=";
    propagatedBuildInputs = [
      pythonPackages.numpy
      pythonPackages.pandas
    ];
    pythonImportsCheck = [ "pandas_ta_classic" ];
  };

  alpacaPy = mkPyWheel {
    pname = "alpaca-py";
    pypiPname = "alpaca_py";
    version = "0.43.5";
    hash = "sha256-C0ysm3Q4UTEPGfapqoT1fd+VrnW2ATUDlXRqiT9Uoto=";
    propagatedBuildInputs = [
      pythonPackages.msgpack
      pythonPackages.pandas
      pythonPackages.pydantic
      pythonPackages.pytz
      pythonPackages.requests
      pythonPackages."sseclient-py"
      pythonPackages.websockets
    ];
    pythonImportsCheck = [ "alpaca" ];
  };

  beartype = mkPyWheel {
    pname = "beartype";
    version = "0.22.2";
    hash = "sha256-Egd6/jUo66XFuAH4FnEvf/BvbaVQmZTHlWHim0i87bg=";
    pythonImportsCheck = [ "beartype" ];
  };

  mcpSdk = mkPyWheel {
    pname = "mcp";
    version = "1.19.0";
    hash = "sha256-9ZB/4cAWclX5FnGPN20F8JqDCiFTJ6PM3V7IpRny5XI=";
    propagatedBuildInputs = [
      pythonPackages.anyio
      pythonPackages.httpx
      pythonPackages."httpx-sse"
      pythonPackages.jsonschema
      pythonPackages.pydantic
      pythonPackages."pydantic-settings"
      pythonPackages."python-multipart"
      pythonPackages."sse-starlette"
      pythonPackages.starlette
      pythonPackages.uvicorn
    ];
    pythonImportsCheck = [ "mcp" ];
  };

  pyKeyValueShared = mkPyWheel {
    pname = "py-key-value-shared";
    pypiPname = "py_key_value_shared";
    version = "0.3.0";
    hash = "sha256-Ww77p+vKCLsVix6Tr8LwfTC49AwvwSziSkwNhPQvkpg=";
    propagatedBuildInputs = [
      beartype
      pythonPackages."typing-extensions"
    ];
    pythonImportsCheck = [ "key_value.shared" ];
  };

  pyKeyValueAio = mkPyWheel {
    pname = "py-key-value-aio";
    pypiPname = "py_key_value_aio";
    version = "0.3.0";
    hash = "sha256-HHgZFXZgeL/WCNqnaf77l+ZdHXN0aj37ZARg4yIHG2Q=";
    propagatedBuildInputs = [
      pyKeyValueShared
      beartype
      pythonPackages.cachetools
      pythonPackages.diskcache
      pythonPackages.pathvalidate
    ];
    pythonImportsCheck = [ "key_value.aio" ];
  };

  fastmcp = mkPyWheel {
    pname = "fastmcp";
    version = "2.13.2";
    hash = "sha256-MAxZ65cMI1u50FdYgzIpIuTy4kaKPUXpDL/Wsjt74kU=";
    propagatedBuildInputs = [
      dotenv
      mcpSdk
      pyKeyValueAio
      pythonPackages.authlib
      pythonPackages.cyclopts
      pythonPackages."email-validator"
      pythonPackages.exceptiongroup
      pythonPackages."openapi-pydantic"
      pythonPackages."jsonschema-path"
      pythonPackages.platformdirs
      pythonPackages.pydantic
      pythonPackages.pyperclip
      pythonPackages.rich
      pythonPackages.uvicorn
      pythonPackages.websockets
    ];
    pythonImportsCheck = [ "fastmcp" ];
  };

  alpacaMcpServer = mkPyWheel {
    pname = "alpaca-mcp-server";
    pypiPname = "alpaca_mcp_server";
    version = "2.0.1";
    hash = "sha256-XjcoNwD8EZmeirHnpLNdlFQle3QCx01MMBryAkIp3gU=";
    propagatedBuildInputs = [
      pythonPackages.click
      fastmcp
      pythonPackages.httpx
      pythonPackages."python-dotenv"
    ];
    pythonImportsCheck = [ "alpaca_mcp_server" ];
  };

  runnerPython = pkgs.python312.withPackages (
    ps: [
      alpacaMcpServer
      alpacaPy
      ps.duckdb
      exchangeCalendars
      ps.httpx
      ps.numpy
      ps.orjson
      ps.pandas
      pandasTaClassic
      ps.polars
      ps.pyarrow
      ps.pydantic
      ps.tenacity
    ]
  );

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
    x86_64-linux = "sha256-EY+nZK3pCullEk0zPkKQVY54wMFO/WzPPSitfZlhe5M=";
    aarch64-linux = "sha256-uA8804g8MEmdyARzsVe4VrSoIlwunEq8rEcxkvdh1ek=";
  };

  installFilters = [
    "@proompteng/agent-contracts"
    "@proompteng/agents"
    "@proompteng/codex"
    "@proompteng/cx-tools"
    "@proompteng/otel"
    "@proompteng/temporal-bun-sdk"
  ];

  serviceSourcePaths = [
    "charts/agents/crds"
    "packages/agent-contracts"
    "packages/codex"
    "packages/cx-tools"
    "packages/otel"
    "packages/temporal-bun-sdk"
    "services/agents"
  ];

  runnerSourcePaths = [
    "packages/codex"
    "services/agents/package.json"
    "services/agents/scripts/codex"
    "services/agents/scripts/codex-config-container.toml"
    "services/agents/src/linear-mcp/bridge-auth.ts"
    "services/agents/src/linear-mcp/config.ts"
    "services/agents/src/linear-mcp/contract.ts"
    "services/agents/src/runner"
    "services/agents/tsconfig.json"
  ];

  runtimeSourceFilter = rel: _type:
    !(lib.hasPrefix "services/agents/Dockerfile" rel
      || lib.hasPrefix "services/agents/agentctl/" rel
      || lib.hasInfix "/__snapshots__/" rel
      || lib.hasInfix "/__tests__/" rel
      || lib.hasInfix "/tests/" rel
      || lib.hasSuffix ".md" rel
      || lib.hasSuffix ".mdx" rel
      || lib.hasSuffix ".snap" rel
      || lib.hasSuffix ".spec.ts" rel
      || lib.hasSuffix ".spec.tsx" rel
      || lib.hasSuffix ".test.ts" rel
      || lib.hasSuffix ".test.tsx" rel);

  serviceRuntimeSourceFilter = rel: type:
    runtimeSourceFilter rel type
    && !(lib.hasPrefix "services/agents/scripts/codex/" rel
      || lib.hasPrefix "services/agents/src/runner/" rel);

  serviceBuildCommands = [
    "patchShebangs --build node_modules"
    "bun --cwd=packages/agent-contracts run build"
    "bun --cwd=packages/codex run build"
    "bun --cwd=packages/otel run build"
    "bun --cwd=packages/temporal-bun-sdk run build"
    "bun --cwd=packages/cx-tools run build"
    "bun --cwd=services/agents run tsc"
    "bun --cwd=services/agents run build"
  ];

  runnerBuildCommands = [
    "patchShebangs --build node_modules"
    "bun --cwd=packages/codex run build"
    ''mkdir -p "$TMPDIR/agents-runner"''
    ''bun build services/agents/scripts/codex/agent-runner.ts --target bun --outfile "$TMPDIR/agents-runner/agent-runner.js"''
    ''bun build services/agents/scripts/codex/linear-mcp-bridge.ts --target bun --outfile "$TMPDIR/agents-runner/linear-mcp-bridge.js"''
    ''bun build services/agents/scripts/codex/fake-app-server.ts --target bun --outfile "$TMPDIR/agents-runner/fake-app-server.js"''
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

    linkBunIsolatedPackage() {
      local package_name="$1"
      local target_path="$2"
      local package_path
      local relative_package_path

      package_path="$(find "$out/app/node_modules/.bun" -path "*/node_modules/$package_name" -type d -print -quit)"
      if [ -z "$package_path" ]; then
        echo "Bun isolated package not found in runtime image: $package_name" >&2
        exit 1
      fi
      relative_package_path="$(realpath --relative-to="$(dirname "$target_path")" "$package_path")"

      rm -rf "$target_path"
      mkdir -p "$(dirname "$target_path")"
      ln -s "$relative_package_path" "$target_path"
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
    linkBunIsolatedPackage "effect" "$out/app/packages/agent-contracts/node_modules/effect"
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

  runnerRuntimeContents = [
    bun
    nodejs
    openaiCodexCli
    pkgs.bash
    pkgs.cacert
    pkgs.coreutils
    pkgs.curl
    pkgs.gh
    pkgs.git
    pkgs.jq
    pkgs.openssh
    pkgs.uv
    runnerPython
  ];

  # Control-plane, controller, and shell images contain the same compiled Agents
  # workspace. Realize that workspace once and keep each final OCI image thin.
  agentsRuntimeRoot = import ./bun-workspace-service.nix {
    inherit
      pkgs
      lib
      repoRoot
      bun
      nodejs
      depsHash
      installFilters
      runtimeInstallPhase
      ;
    sourcePaths = serviceSourcePaths;
    runtimeSourceFilter = serviceRuntimeSourceFilter;
    buildCommands = serviceBuildCommands;
    depsName = "agents-controller";
    packageName = "@proompteng/agents";
    serviceName = "agents";
    imageName = "agents-runtime-root";
    dependencyClosure = "bunCache";
    command = [ ];
    returnRuntimeRoot = true;
  };

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
        runtimeInstallPhase
        command
        env
        extraContents
        exposedPorts
        ;
      sourcePaths = serviceSourcePaths;
      runtimeSourceFilter = serviceRuntimeSourceFilter;
      buildCommands = serviceBuildCommands;
      depsName = "agents-controller";
      packageName = "@proompteng/agents";
      inherit serviceName imageName;
      dependencyClosure = "bunCache";
      runtimeRoot = agentsRuntimeRoot;
      workingDir = "/app/services/agents";
    };

  runnerRuntimeInstallPhase = ''
    mkdir -p \
      "$out/app/node_modules/@proompteng/codex" \
      "$out/app/services/agents/scripts/codex" \
      "$out/root/.codex" \
      "$out/workspace" \
      "$out/usr/bin" \
      "$out/usr/local/bin"

    cp "$TMPDIR/work/packages/codex/package.json" "$out/app/node_modules/@proompteng/codex/package.json"
    cp -R "$TMPDIR/work/packages/codex/dist" "$out/app/node_modules/@proompteng/codex/dist"
    cp "$TMPDIR/agents-runner/agent-runner.js" "$out/app/services/agents/scripts/codex/agent-runner.js"
    cp "$TMPDIR/agents-runner/linear-mcp-bridge.js" "$out/app/services/agents/scripts/codex/linear-mcp-bridge.js"
    cp "$TMPDIR/agents-runner/fake-app-server.js" "$out/app/services/agents/scripts/codex/fake-app-server.js"
    cp "$TMPDIR/work/services/agents/scripts/codex-config-container.toml" "$out/root/.codex/config.toml"
    printf '{}\n' > "$out/root/.codex/auth.json"
    printf '%s\n' unspecified > "$out/root/.codex/auth.checksum"

    cat > "$out/usr/local/bin/agent-runner" <<'EOF'
    #!${pkgs.bash}/bin/bash
    exec ${bun}/bin/bun /app/services/agents/scripts/codex/agent-runner.js "$@"
    EOF
    cat > "$out/usr/local/bin/agents-fake-codex-app-server" <<'EOF'
    #!${pkgs.bash}/bin/bash
    exec ${bun}/bin/bun /app/services/agents/scripts/codex/fake-app-server.js "$@"
    EOF
    cat > "$out/usr/local/bin/linear-mcp-bridge" <<'EOF'
    #!${pkgs.bash}/bin/bash
    exec ${bun}/bin/bun /app/services/agents/scripts/codex/linear-mcp-bridge.js "$@"
    EOF
    ln -s ${openaiCodexCli}/bin/codex "$out/usr/local/bin/codex"
    ln -s ${openaiCodexCli}/bin/codex "$out/usr/bin/codex"
    ln -s ${runnerPython}/bin/alpaca-mcp-server "$out/usr/local/bin/alpaca-mcp-server"
    chmod +x \
      "$out/usr/local/bin/agent-runner" \
      "$out/usr/local/bin/linear-mcp-bridge" \
      "$out/usr/local/bin/agents-fake-codex-app-server" \
      "$out/app/services/agents/scripts/codex/agent-runner.js" \
      "$out/app/services/agents/scripts/codex/linear-mcp-bridge.js" \
      "$out/app/services/agents/scripts/codex/fake-app-server.js"

    fake_server="$TMPDIR/agents-fake-codex-app-server"
    cat > "$fake_server" <<EOF
    #!${pkgs.bash}/bin/bash
    exec ${bun}/bin/bun "$out/app/services/agents/scripts/codex/fake-app-server.js" "\$@"
    EOF
    chmod +x "$fake_server"
    printf '%s\n' \
      '{"implementation":{"text":"Write `/tmp/agents-runner-smoke/result.md` and respond OK."},"goal":{"objective":"image smoke"}}' \
      > "$TMPDIR/agent-runner-run.json"
    printf '%s\n' \
      '{"schemaVersion":"agents.proompteng.ai/runner/v1","provider":"image-smoke","payloads":{"eventFilePath":"'"$TMPDIR"'/agent-runner-run.json"},"artifacts":{"statusPath":"'"$TMPDIR"'/agent-runner-status.json","logPath":"'"$TMPDIR"'/agent-runner.log"},"providerSpec":{"outputArtifacts":[{"name":"smoke-result","path":"/tmp/agents-runner-smoke/result.md"}]},"adapter":{"type":"codex-app-server","codex":{"binaryPath":"'"$fake_server"'","model":"agents-fake-codex-app-server","effort":"low","sandbox":"danger-full-access","approval":"never","prompt":"Write `/tmp/agents-runner-smoke/result.md` and respond OK.","goal":{"objective":"image smoke"}}}}' \
      > "$TMPDIR/agent-runner-smoke.json"
    ${bun}/bin/bun "$out/app/services/agents/scripts/codex/agent-runner.js" "$TMPDIR/agent-runner-smoke.json"
    test -s /tmp/agents-runner-smoke/result.md
    rm -f /tmp/agents-runner-smoke/result.md
  '';

  mkRunnerImage =
    import ./bun-workspace-service.nix {
      inherit
        pkgs
        lib
        repoRoot
        bun
        nodejs
        depsHash
        installFilters
        ;
      sourcePaths = runnerSourcePaths;
      inherit runtimeSourceFilter;
      depsName = "agents-controller";
      packageName = "@proompteng/agents-codex-runner";
      serviceName = "agents-codex-runner";
      imageName = "agents-codex-runner";
      dependencyClosure = "bunCache";
      buildCommands = runnerBuildCommands;
      runtimeInstallPhase = runnerRuntimeInstallPhase;
      command = [ "bash" ];
      workingDir = "/workspace";
      extraContents = runnerRuntimeContents;
      env = [
        "WORKSPACE=/workspace"
        "WORKTREE=/workspace/lab"
        "GIT_TERMINAL_PROMPT=0"
        "AGENTS_CODEX_BINARY=/usr/local/bin/codex"
        "CODEX_BINARY=/usr/local/bin/codex"
        "BUN_INSTALL=/usr/local"
        "BUN_INSTALL_CACHE_DIR=/opt/bun/install/cache"
        "BUN_INSTALL_CACHE_SEED_DIR=/opt/bun/install/cache"
      ];
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

  "agents-codex-runner-image" = mkRunnerImage;
}
