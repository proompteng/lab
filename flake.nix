{
  description = "Lab repository development and CI toolchain";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/ee09932cedcef15aaf476f9343d1dea2cb77e261";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      forAllSystems = f: builtins.listToAttrs (map (system: { name = system; value = f system; }) systems);

      mkSystem =
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = false;
          };
          lib = pkgs.lib;

          assertVersion =
            name: expected: pkg:
            let
              actual = toString (lib.getVersion pkg);
            in
            if actual == expected then pkg else throw "${name} expected ${expected}, got ${actual}";

          exact = import ./nix/packages.nix { inherit pkgs lib system; };
          repoRevision = self.rev or self.dirtyRev or "dirty";
          repoShortRevision =
            if builtins.stringLength repoRevision >= 12 then builtins.substring 0 12 repoRevision else repoRevision;

          nodejs = assertVersion "nodejs_24" "24.11.1" pkgs.nodejs_24;
          go = exact.go;
          ruby = assertVersion "ruby_3_4" "3.4.7" pkgs.ruby_3_4;

          shellPackages = [
            pkgs.nixVersions.nix_2_28
            nodejs
            exact.bun
            go
            ruby
            pkgs.python311
            pkgs.python312
            pkgs.uv
            pkgs.opentofu
            exact.helm
            exact.kustomize
            exact.kubeconform
            exact.kubectl
            exact.argo-workflows
            pkgs.argocd
            pkgs.buf
            pkgs.gh
            exact.shellcheck
            pkgs.jq
            exact.yq
            pkgs.ripgrep
            pkgs.fd
            pkgs.fzf
            pkgs.git
            pkgs.gnumake
            pkgs.pkg-config
            pkgs.openssl
            pkgs.zlib
            pkgs.buildkit
            pkgs.docker-client
            pkgs.docker-buildx
            pkgs.go-containerregistry
            pkgs.skopeo
            pkgs.regclient
            pkgs.cosign
            pkgs.attic-client
          ] ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
            pkgs.libiconv
          ];

          mkShellScript =
            name: runtimeInputs: text:
            pkgs.writeTextFile {
              inherit name;
              destination = "/bin/${name}";
              executable = true;
              text = ''
                #!${pkgs.runtimeShell}
                set -euo pipefail
                export PATH=${lib.makeBinPath runtimeInputs}:$PATH

              '' + text;
            };

          toolchainDoctor = mkShellScript "toolchain-doctor" (
            shellPackages ++ [
              pkgs.gawk
              pkgs.gnugrep
            ]
          ) (builtins.readFile ./nix/toolchain-doctor.sh);

          ociDoctor = mkShellScript "oci-doctor" (
            shellPackages ++ [
              pkgs.coreutils
              pkgs.gawk
            ]
          ) (builtins.readFile ./nix/oci-doctor.sh);

          mkScript =
            name: text:
            mkShellScript name (shellPackages ++ [ pkgs.bash ]) text;

          mkOciScript =
            name: text:
            mkShellScript name [
              exact.bun
              pkgs.go-containerregistry
              pkgs.regclient
            ] text;

          lintArgocd = mkScript "lint-argocd" ''
            exec bash scripts/kubeconform.sh argocd
          '';

          renderHeadlamp = mkScript "render-headlamp" ''
            exec kustomize build --enable-helm argocd/applications/headlamp >/dev/null
          '';

          lintArgoWorkflows = mkScript "lint-argo-workflows" ''
            exec bash scripts/argo-lint.sh
          '';

          cacheDoctor = mkShellScript "cache-doctor" [
            pkgs.bash
            pkgs.coreutils
            pkgs.curl
            pkgs.gawk
            pkgs.gnugrep
            pkgs.nixVersions.nix_2_28
          ] (builtins.readFile ./nix/cache-doctor.sh);

          cachePush = mkShellScript "cache-push" [
            pkgs.attic-client
            pkgs.bash
            pkgs.coreutils
          ] (builtins.readFile ./nix/cache-push.sh);

          ociPush = mkShellScript "oci-push" [
            pkgs.bash
            pkgs.coreutils
            pkgs.go-containerregistry
            pkgs.skopeo
          ] (builtins.readFile ./nix/oci-push.sh);

          inspectOciArchive = mkShellScript "inspect-oci-archive" [
            pkgs.bash
            pkgs.coreutils
            pkgs.jq
            pkgs.skopeo
          ] (builtins.readFile ./nix/oci-inspect-archive.sh);

          writeOciReleaseContract = mkShellScript "write-oci-release-contract" [
            pkgs.bash
            pkgs.coreutils
            pkgs.jq
          ] (builtins.readFile ./nix/oci-release-contract.sh);

          resolveAtticReleaseMetadata = mkShellScript "resolve-attic-release-metadata" [
            pkgs.bash
            pkgs.coreutils
            pkgs.git
            pkgs.gnugrep
            pkgs.go-containerregistry
            pkgs.jq
          ] (builtins.readFile ./nix/attic-release-metadata.sh);

          createOciIndex = mkOciScript "create-oci-index" ''
            exec bun run packages/scripts/src/shared/oci.ts create-index "$@"
          '';

          inspectOciImage = mkOciScript "inspect-oci-image" ''
            exec bun run packages/scripts/src/shared/oci.ts inspect "$@"
          '';

          assertOciPlatforms = mkOciScript "assert-oci-platforms" ''
            exec bun run packages/scripts/src/shared/oci.ts assert "$@"
          '';

          ciToolchain = pkgs.buildEnv {
            name = "lab-ci-toolchain";
            paths = shellPackages ++ [
              toolchainDoctor
              ociDoctor
              cacheDoctor
              cachePush
              ociPush
              inspectOciArchive
              writeOciReleaseContract
              resolveAtticReleaseMetadata
              createOciIndex
              inspectOciImage
              assertOciPlatforms
            ];
            pathsToLink = [ "/bin" ];
            ignoreCollisions = true;
          };

          linuxPackages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux ({
            "atticd-image" = import ./nix/images/attic.nix { inherit pkgs lib; };
            "arc-runner-image" = import ./nix/images/arc-runner.nix {
              inherit pkgs lib ciToolchain;
            };
            "oirat-image" = import ./nix/images/oirat.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "bumba-image" = import ./nix/images/bumba.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "froussard-image" = import ./nix/images/froussard.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "docs-image" = import ./nix/images/docs.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "olden-image" = import ./nix/images/olden.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "proompteng-image" = import ./nix/images/proompteng.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "app-image" = import ./nix/images/app.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "synthesis-image" = import ./nix/images/synthesis.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "symphony-image" = import ./nix/images/symphony.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "bayn-image" = import ./nix/images/bayn.nix {
              inherit pkgs lib nodejs repoRevision;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "sag-image" = import ./nix/images/sag.nix {
              inherit pkgs lib nodejs;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "jangar-image" = import ./nix/images/jangar.nix {
              inherit
                pkgs
                lib
                nodejs
                exact
                repoRevision
                ;
              repoRoot = ./.;
              bun = exact.bun;
            };
            "headlamp-image" = import ./nix/images/headlamp.nix {
              inherit pkgs lib repoRevision;
            };
            "torghut-image" = import ./nix/images/torghut.nix {
              inherit pkgs lib;
              repoRoot = ./.;
            };
            "torghut-ws-image" = import ./nix/images/torghut-ws.nix {
              inherit pkgs lib;
              repoRoot = ./.;
            };
            "torghut-ta-image" = import ./nix/images/torghut-ta.nix {
              inherit pkgs lib;
              repoRoot = ./.;
            };
            "torghut-hyperliquid-feed-image" = import ./nix/images/torghut-hyperliquid-feed.nix {
              inherit pkgs lib;
              repoRoot = ./.;
            };
            "torghut-notebook-image" = import ./nix/images/torghut-notebook.nix {
              inherit pkgs lib repoRevision;
              repoRoot = ./.;
            };
          } // (import ./nix/images/agents.nix {
            inherit
              pkgs
              lib
              nodejs
              exact
              ;
            repoRoot = ./.;
            bun = exact.bun;
          }));

          mkApp = drv: {
            type = "app";
            program = lib.getExe drv;
            meta.description = drv.meta.description or "${drv.name} application";
          };
        in
        {
          packages = exact // linuxPackages // {
            default = toolchainDoctor;
            inherit
              toolchainDoctor
              ociDoctor
              lintArgocd
              renderHeadlamp
              lintArgoWorkflows
              cacheDoctor
              cachePush
              ociPush
              inspectOciArchive
              writeOciReleaseContract
              resolveAtticReleaseMetadata
              createOciIndex
              inspectOciImage
              assertOciPlatforms
              ciToolchain
              ;
            atticClient = pkgs.attic-client;
            atticServer = pkgs.attic-server;
          };

          apps = {
            default = mkApp toolchainDoctor;
            toolchain-doctor = mkApp toolchainDoctor;
            oci-doctor = mkApp ociDoctor;
            lint-argocd = mkApp lintArgocd;
            render-headlamp = mkApp renderHeadlamp;
            lint-argo-workflows = mkApp lintArgoWorkflows;
            cache-doctor = mkApp cacheDoctor;
            cache-push = mkApp cachePush;
            oci-push = mkApp ociPush;
            inspect-oci-archive = mkApp inspectOciArchive;
            write-oci-release-contract = mkApp writeOciReleaseContract;
            resolve-attic-release-metadata = mkApp resolveAtticReleaseMetadata;
            create-oci-index = mkApp createOciIndex;
            inspect-oci-image = mkApp inspectOciImage;
            assert-oci-platforms = mkApp assertOciPlatforms;
          };

          devShells.default = pkgs.mkShell {
            packages = shellPackages ++ [
              toolchainDoctor
              ociDoctor
              cacheDoctor
              cachePush
              ociPush
              inspectOciArchive
              writeOciReleaseContract
              resolveAtticReleaseMetadata
            ];
            shellHook = ''
              export LAB_NIX_TOOLCHAIN=1
            '';
          };

        };

    in
    {
      packages = forAllSystems (system: (mkSystem system).packages);
      apps = forAllSystems (system: (mkSystem system).apps);
      devShells = forAllSystems (system: (mkSystem system).devShells);
    };
}
