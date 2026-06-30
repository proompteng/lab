import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

const setupAction = readRepoFile('.github/actions/setup-nix-toolchain/action.yml')
const arcApplication = readRepoFile('argocd/applications/arc/application.yaml')
const arcRunnerDockerfile = readRepoFile('images/arc-runner/Dockerfile')
const arcRunnerBuildWorkflow = readRepoFile('.github/workflows/arc-runner-build-push.yml')
const arcRunnerReleaseWorkflow = readRepoFile('.github/workflows/arc-runner-release.yml')
const nixOciWorkflow = readRepoFile('.github/workflows/nix-oci-build-common.yml')
const atticReleaseWorkflow = readRepoFile('.github/workflows/attic-release.yml')
const argoLintWorkflow = readRepoFile('.github/workflows/argo-lint.yml')
const kubeconformWorkflow = readRepoFile('.github/workflows/kubeconform.yml')
const khoshutWorkflow = readRepoFile('.github/workflows/khoshut-ci.yml')
const headlampWorkflow = readRepoFile('.github/workflows/headlamp-ci.yml')
const flake = readRepoFile('flake.nix')
const nixPackages = readRepoFile('nix/packages.nix')
const toolchainDoctor = readRepoFile('nix/toolchain-doctor.sh')

describe('ARC Nix runner toolchain', () => {
  it('keeps ARC storage and Docker sidecar unchanged while making runner images releasable by digest', () => {
    expect(arcApplication).toContain('runnerScaleSetName: arc-arm64')
    expect(arcApplication).toContain('runnerScaleSetName: arc-amd64')
    expect(arcApplication).toContain('runnerScaleSetName: analysis-arm64')
    expect(arcApplication).toContain('image: docker:dind')
    expect(arcApplication).toContain('storageClassName: "rook-ceph-block"')
    expect(arcApplication).toContain('volumeClaimTemplate:')
    expect(arcRunnerReleaseWorkflow).toContain('registry.ide-newton.ts.net/lab/arc-runner')
    expect(arcRunnerReleaseWorkflow).toContain('arc-runner\\@sha256')
    expect(arcRunnerReleaseWorkflow).toContain('test "$(grep -cF "image: ${IMAGE_REF}"')
    expect(arcRunnerReleaseWorkflow).toContain("grep -F 'image: docker:dind'")
    expect(arcRunnerReleaseWorkflow).toContain('grep -F \'storageClassName: "rook-ceph-block"\'')
    expect(arcRunnerReleaseWorkflow).not.toContain('ObjectBucketClaim')
    expect(arcRunnerReleaseWorkflow).not.toContain('PersistentVolumeClaim')
  })

  it('builds a custom actions runner image with pinned Nix CI tools preinstalled', () => {
    expect(arcRunnerDockerfile).toContain('FROM ${ACTIONS_RUNNER_BASE}')
    expect(arcRunnerDockerfile).toContain(
      'ghcr.io/actions/actions-runner@sha256:08c30b0a7105f64bddfc485d2487a22aa03932a791402393352fdf674bda2c29',
    )
    expect(arcRunnerDockerfile).not.toContain('ghcr.io/actions/actions-runner:latest')
    expect(arcRunnerDockerfile).toContain('https://releases.nixos.org/nix/nix-2.28.5/install')
    expect(arcRunnerDockerfile).toContain('ARG LAB_NIX_EXTRA_SUBSTITUTERS=')
    expect(arcRunnerDockerfile).toContain('ARG LAB_NIX_EXTRA_TRUSTED_PUBLIC_KEYS=')
    expect(arcRunnerDockerfile).toContain('extra-substituters = ${LAB_NIX_EXTRA_SUBSTITUTERS}')
    expect(arcRunnerDockerfile).toContain('extra-trusted-public-keys = ${LAB_NIX_EXTRA_TRUSTED_PUBLIC_KEYS}')
    expect(arcRunnerDockerfile).toContain('COPY --chown=runner:runner flake.nix flake.lock ./')
    expect(arcRunnerDockerfile).toContain('COPY --chown=runner:runner nix ./nix')
    expect(arcRunnerDockerfile).toContain(
      'sh /tmp/install-nix.sh --no-daemon --yes --no-channel-add --no-modify-profile',
    )
    expect(arcRunnerDockerfile).toContain('nix profile install .#ciToolchain --priority 4')
    expect(arcRunnerDockerfile).toContain('toolchain-doctor')
    expect(arcRunnerDockerfile).toContain('oci-doctor')
    expect(flake).toContain('ciToolchain = pkgs.buildEnv')
    expect(flake).toContain('name = "lab-ci-toolchain"')
    expect(flake).toContain('pathsToLink = [ "/bin" ]')
    expect(flake).toContain('ignoreCollisions = true')
    expect(nixPackages).toContain('pkgs.kubernetes-helm')
    expect(nixPackages).toContain('lib.versions.major')
    expect(nixPackages).toContain('kubernetes-helm must stay on Helm 3')
    expect(nixPackages).not.toContain('https://github.com/helm/helm/releases/download/v${helmVersion}/')
    expect(nixPackages).not.toContain('https://get.helm.sh/helm-v${helmVersion}-')
    expect(toolchainDoctor).toContain('expect_prefix helm v3.')
    expect(toolchainDoctor).not.toContain('expect_eq helm v3.14.4')
  })

  it('publishes multi-arch ARC runner images and opens a digest-pinning release PR', () => {
    expect(arcRunnerBuildWorkflow).toContain('runner: arc-amd64')
    expect(arcRunnerBuildWorkflow).toContain('runner: arc-arm64')
    expect(arcRunnerBuildWorkflow).toContain('Prepare minimal runner image context')
    expect(arcRunnerBuildWorkflow).toContain('cp flake.nix flake.lock .artifacts/arc-runner-context/')
    expect(arcRunnerBuildWorkflow).toContain('Require Attic public key')
    expect(arcRunnerBuildWorkflow).toContain('ATTIC_PUBLIC_KEY: ${{ vars.ATTIC_PUBLIC_KEY }}')
    expect(arcRunnerBuildWorkflow).toContain(
      '--build-arg "LAB_NIX_EXTRA_SUBSTITUTERS=http://attic.attic.svc.cluster.local/lab"',
    )
    expect(arcRunnerBuildWorkflow).toContain('--build-arg "LAB_NIX_EXTRA_TRUSTED_PUBLIC_KEYS=${ATTIC_PUBLIC_KEY}"')
    expect(arcRunnerBuildWorkflow).toContain('docker buildx build')
    expect(arcRunnerBuildWorkflow).toContain('--platform "${PLATFORM}"')
    expect(arcRunnerBuildWorkflow).toContain(
      '[[ "${GITHUB_EVENT_NAME}" == "push" || "${GITHUB_EVENT_NAME}" == "workflow_dispatch" ]]',
    )
    expect(arcRunnerBuildWorkflow).toContain('if [[ "${should_publish}" == "true" ]]; then')
    expect(arcRunnerBuildWorkflow).toContain('--push')
    expect(arcRunnerBuildWorkflow).toContain('docker buildx imagetools create')
    expect(arcRunnerBuildWorkflow).toContain("github.event_name == 'workflow_dispatch'")
    expect(arcRunnerBuildWorkflow).toContain('linux/amd64')
    expect(arcRunnerBuildWorkflow).toContain('linux/arm64')
    expect(arcRunnerBuildWorkflow).toContain('arc-runner-release-contract')
    expect(arcRunnerReleaseWorkflow).toContain('workflows:')
    expect(arcRunnerReleaseWorkflow).toContain('arc-runner-build-push')
    expect(arcRunnerReleaseWorkflow).toContain('peter-evans/create-pull-request@v7')
    expect(arcRunnerReleaseWorkflow).toContain('argocd/applications/arc/application.yaml')
  })

  it('uses a shared setup action so Nix jobs validate preinstalled tools before falling back', () => {
    expect(setupAction).toContain('Detect preinstalled Nix')
    expect(setupAction).toContain("steps.detect.outputs.nix_available != 'true'")
    expect(setupAction).toContain('uses: cachix/install-nix-action@v31')
    expect(setupAction).toContain('extra_nix_config: ${{ inputs.extra-nix-config }}')
    expect(setupAction).toContain('NIX_CONFIG<<__LAB_NIX_CONFIG__')
    expect(setupAction).toContain('nix profile install .#ciToolchain --priority 4')
    expect(setupAction).toContain('toolchain-doctor')
    expect(setupAction).toContain('oci-doctor')

    for (const workflow of [
      nixOciWorkflow,
      atticReleaseWorkflow,
      argoLintWorkflow,
      kubeconformWorkflow,
      khoshutWorkflow,
      headlampWorkflow,
    ]) {
      expect(workflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
    }

    expect(nixOciWorkflow).not.toContain('Install xz for Nix installer')
    expect(nixOciWorkflow).not.toContain('uses: cachix/install-nix-action@v31')
    expect(atticReleaseWorkflow).not.toContain('Install xz for Nix installer')
    expect(atticReleaseWorkflow).not.toContain('uses: cachix/install-nix-action@v31')
  })
})
