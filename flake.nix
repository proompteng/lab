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

          lintArgocd = mkScript "lint-argocd" ''
            exec bash scripts/kubeconform.sh argocd
          '';

          renderHeadlamp = mkScript "render-headlamp" ''
            exec kustomize build --enable-helm argocd/applications/headlamp >/dev/null
          '';

          lintArgoWorkflows = mkScript "lint-argo-workflows" ''
            exec bash scripts/argo-lint.sh
          '';

          inspectOciImage = mkScript "inspect-oci-image" ''
            exec bun run packages/scripts/src/shared/oci.ts inspect "$@"
          '';

          assertOciPlatforms = mkScript "assert-oci-platforms" ''
            exec bun run packages/scripts/src/shared/oci.ts assert "$@"
          '';

          mkApp = drv: {
            type = "app";
            program = lib.getExe drv;
            meta.description = drv.meta.description or "${drv.name} application";
          };
        in
        {
          packages = exact // {
            default = toolchainDoctor;
            inherit
              toolchainDoctor
              ociDoctor
              lintArgocd
              renderHeadlamp
              lintArgoWorkflows
              inspectOciImage
              assertOciPlatforms
              ;
          };

          apps = {
            default = mkApp toolchainDoctor;
            toolchain-doctor = mkApp toolchainDoctor;
            oci-doctor = mkApp ociDoctor;
            lint-argocd = mkApp lintArgocd;
            render-headlamp = mkApp renderHeadlamp;
            lint-argo-workflows = mkApp lintArgoWorkflows;
            inspect-oci-image = mkApp inspectOciImage;
            assert-oci-platforms = mkApp assertOciPlatforms;
          };

          devShells.default = pkgs.mkShell {
            packages = shellPackages ++ [
              toolchainDoctor
              ociDoctor
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
