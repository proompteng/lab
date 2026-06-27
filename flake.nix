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

          nodejs = assertVersion "nodejs_24" "24.11.1" pkgs.nodejs_24;
          go = exact.go;
          ruby = assertVersion "ruby_3_4" "3.4.7" pkgs.ruby_3_4;

          shellPackages = [
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

          cacheSmoke =
            let
              repoRevision = self.rev or self.dirtyRev or "dirty";
              repoLastModified = self.lastModifiedDate or "unknown";
            in
            pkgs.runCommand "lab-cache-smoke-${repoRevision}" {
              inherit repoRevision repoLastModified;
              cacheSmokeInput = ./nix/cache-smoke-input.txt;
            } ''
              mkdir -p "$out"
              cp "$cacheSmokeInput" "$out/input.txt"
              printf '%s\n' \
                'lab attic cache smoke' \
                "repoRevision=$repoRevision" \
                "repoLastModified=$repoLastModified" \
                "system=${system}" \
                > "$out/proof.txt"
            '';

          cacheSmokeApp = mkShellScript "cache-smoke" [ pkgs.coreutils ] ''
            cat ${cacheSmoke}/proof.txt
          '';

          createOciIndex = mkOciScript "create-oci-index" ''
            exec bun run packages/scripts/src/shared/oci.ts create-index "$@"
          '';

          inspectOciImage = mkOciScript "inspect-oci-image" ''
            exec bun run packages/scripts/src/shared/oci.ts inspect "$@"
          '';

          assertOciPlatforms = mkOciScript "assert-oci-platforms" ''
            exec bun run packages/scripts/src/shared/oci.ts assert "$@"
          '';

          linuxPackages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            "atticd-image" = pkgs.dockerTools.buildLayeredImage {
              name = "registry.ide-newton.ts.net/lab/attic";
              tag = "dev";
              contents = [
                pkgs.attic-client
                pkgs.attic-server
                pkgs.cacert
              ];
              config = {
                Entrypoint = [ "atticd" ];
                Env = [
                  "PATH=${lib.makeBinPath [
                    pkgs.attic-client
                    pkgs.attic-server
                    pkgs.coreutils
                  ]}"
                  "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                ];
                ExposedPorts = {
                  "8080/tcp" = { };
                };
                User = "65532:65532";
              };
            };
          };

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
              cacheSmoke
              createOciIndex
              inspectOciImage
              assertOciPlatforms
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
            cache-smoke = mkApp cacheSmokeApp;
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
