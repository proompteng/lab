import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

const setupAction = readRepoFile('.github/actions/setup-nix-toolchain/action.yml')
const arcApplication = readRepoFile('argocd/applications/arc/application.yaml')
const arcRunnerImage = readRepoFile('nix/images/arc-runner.nix')
const arcRunnerBuildWorkflow = readRepoFile('.github/workflows/arc-runner-build-push.yml')
const arcRunnerReleaseWorkflow = readRepoFile('.github/workflows/arc-runner-release.yml')
const nixOciWorkflow = readRepoFile('.github/workflows/nix-oci-build-common.yml')
const atticReleaseWorkflow = readRepoFile('.github/workflows/attic-release.yml')
const agentsBuildWorkflow = readRepoFile('.github/workflows/agents-build-push.yml')
const argoLintWorkflow = readRepoFile('.github/workflows/argo-lint.yml')
const enabledProductReleaseWorkflow = readRepoFile('.github/workflows/enabled-product-nix-release.yml')
const enabledSimpleReleaseWorkflow = readRepoFile('.github/workflows/enabled-simple-nix-release.yml')
const kubeconformWorkflow = readRepoFile('.github/workflows/kubeconform.yml')
const khoshutWorkflow = readRepoFile('.github/workflows/khoshut-ci.yml')
const headlampWorkflow = readRepoFile('.github/workflows/headlamp-ci.yml')
const sagReleaseWorkflow = readRepoFile('.github/workflows/sag-release.yml')
const symphonyReleaseWorkflow = readRepoFile('.github/workflows/symphony-release.yml')
const flake = readRepoFile('flake.nix')
const nixPackages = readRepoFile('nix/packages.nix')
const toolchainDoctor = readRepoFile('nix/toolchain-doctor.sh')

const runnerScaleSetBlock = (name: string): string => {
  const start = arcApplication.indexOf(`runnerScaleSetName: ${name}`)
  expect(start).toBeGreaterThan(-1)

  const next = arcApplication.indexOf('runnerScaleSetName:', start + 1)
  return arcApplication.slice(start, next === -1 ? arcApplication.length : next)
}

const arcRunnerBuildTriggerPaths = Array.from(
  new Set(Array.from(arcRunnerBuildWorkflow.matchAll(/^\s+- '([^']+)'$/gm), ([, path]) => path)),
)

const arcRunnerToolchainScriptPaths = Array.from(
  new Set(Array.from(flake.matchAll(/builtins\.readFile \.\/(nix\/[^)]+\.sh)/g), ([, path]) => path)),
)
const arcRunnerReleaseOnlyScriptPaths = new Set(['nix/oci-release-contract.sh'])

const releaseGuardFragmentForPath = (path: string): string => {
  const guardPath = path.endsWith('/**') ? `${path.slice(0, -3)}/` : path
  return guardPath.replaceAll('.', '\\.')
}

describe('ARC Nix runner toolchain', () => {
  it('keeps lab ARC runners on local work dirs while making runner images releasable by digest', () => {
    expect(arcApplication).toContain('runnerScaleSetName: arc-arm64')
    expect(arcApplication).toContain('runnerScaleSetName: arc-amd64')
    expect(arcApplication).toContain('runnerScaleSetName: analysis-arm64')
    expect(arcApplication).toContain('image: docker:dind')
    for (const scaleSet of ['arc-arm64', 'arc-amd64']) {
      const block = runnerScaleSetBlock(scaleSet)
      expect(block).toContain('emptyDir:')
      expect(block).toContain('sizeLimit: 80Gi')
      expect(block).not.toContain('storageClassName: "rook-ceph-block"')
      expect(block).not.toContain('volumeClaimTemplate:')
    }
    expect(runnerScaleSetBlock('analysis-arm64')).toContain('storageClassName: "rook-ceph-block"')
    expect(arcRunnerReleaseWorkflow).toContain('registry.ide-newton.ts.net/lab/arc-runner')
    expect(arcRunnerReleaseWorkflow).toContain('arc-runner\\@sha256')
    expect(arcRunnerReleaseWorkflow).toContain('test "$(grep -cF "image: ${IMAGE_REF}"')
    expect(arcRunnerReleaseWorkflow).toContain("grep -F 'image: docker:dind'")
    expect(arcRunnerReleaseWorkflow).toContain("grep -cF 'sizeLimit: 80Gi'")
    expect(arcRunnerReleaseWorkflow).not.toContain('ObjectBucketClaim')
    expect(arcRunnerReleaseWorkflow).not.toContain('PersistentVolumeClaim')
  })

  it('keeps lab ARC runners capped until pod CIDR capacity soak completes', () => {
    expect(runnerScaleSetBlock('arc-arm64')).toContain('maxRunners: 10')
    expect(runnerScaleSetBlock('arc-arm64')).toContain('minRunners: 1')
    expect(runnerScaleSetBlock('arc-amd64')).toContain('maxRunners: 10')
    expect(runnerScaleSetBlock('arc-amd64')).toContain('minRunners: 1')
    expect(runnerScaleSetBlock('analysis-arm64')).toContain('maxRunners: 5')
    expect(runnerScaleSetBlock('analysis-arm64')).toContain('minRunners: 1')
  })

  it('keeps lab ARC ephemeral-storage requests small enough for the configured runner scale', () => {
    for (const scaleSet of ['arc-arm64', 'arc-amd64']) {
      const block = runnerScaleSetBlock(scaleSet)
      expect(block).toContain('ephemeral-storage: "4Gi"')
      expect(block).toContain('ephemeral-storage: "6Gi"')
      expect(block).toContain('sizeLimit: 80Gi')
      expect(block).not.toContain('storage: 20Gi')
    }

    expect(runnerScaleSetBlock('analysis-arm64')).toContain('storageClassName: "rook-ceph-block"')
    expect(runnerScaleSetBlock('analysis-arm64')).toContain('storage: 20Gi')
  })

  it('builds a custom actions runner image with pinned Nix CI tools preinstalled', () => {
    expect(existsSync(new URL('images/arc-runner/Dockerfile', repoRoot))).toBe(false)
    expect(arcRunnerImage).toContain('pkgs.dockerTools.pullImage')
    expect(arcRunnerImage).toContain('pkgs.dockerTools.buildLayeredImageWithNixDb')
    expect(arcRunnerImage).toContain('ciToolchain')
    expect(arcRunnerImage).toContain('imageName = "ghcr.io/actions/actions-runner"')
    expect(arcRunnerImage).toContain(
      'imageDigest = "sha256:08c30b0a7105f64bddfc485d2487a22aa03932a791402393352fdf674bda2c29"',
    )
    expect(arcRunnerImage).not.toContain('ghcr.io/actions/actions-runner:latest')
    expect(arcRunnerImage).toContain('LAB_ARC_RUNNER_TOOLCHAIN=1')
    expect(arcRunnerImage).toContain('experimental-features = nix-command flakes')
    expect(arcRunnerImage).toContain('build-users-group =')
    expect(arcRunnerImage).toContain('NIX_PAGER=cat')
    expect(arcRunnerImage).toContain('nix/store')
    expect(arcRunnerImage).toContain('nix/var/nix/db')
    expect(arcRunnerImage).toContain('fakeRootCommands =')
    expect(arcRunnerImage).toContain('chown 1001:1001 ./nix ./nix/store')
    expect(arcRunnerImage).toContain('chown -R 1001:1001 ./nix/var/nix')
    expect(arcRunnerImage).toContain('chmod 1777 tmp var/tmp')
    expect(arcRunnerImage).toContain('cat > etc/nix/nix.conf')
    expect(arcRunnerImage).not.toContain('home/runner/.config')
    expect(arcRunnerImage).not.toContain('home/runner/tmpDir')
    expect(arcRunnerImage).not.toContain('chown -R 1001:1001 home/runner')
    expect(arcRunnerImage).not.toContain('chmod -R u+rwX,go+rX home/runner')
    expect(arcRunnerImage).toContain('User = "runner"')
    expect(arcRunnerImage).toContain('/home/runner/run.sh')
    expect(arcRunnerImage).not.toContain('curl')
    expect(arcRunnerImage).not.toContain('apt-get')
    expect(arcRunnerImage).not.toContain('created = "now"')
    expect(flake).toContain('ciToolchain = pkgs.buildEnv')
    expect(flake).toContain('"arc-runner-image" = import ./nix/images/arc-runner.nix')
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
    expect(arcRunnerBuildWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(arcRunnerBuildWorkflow).toContain('image_name: arc-runner')
    expect(arcRunnerBuildWorkflow).toContain('package_attr: arc-runner-image')
    expect(arcRunnerBuildWorkflow).toContain('arc-runner-release-contract')
    expect(arcRunnerBuildWorkflow).toContain(
      "latest: ${{ (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' }}",
    )
    expect(arcRunnerBuildWorkflow).not.toContain("- 'flake.nix'")
    expect(arcRunnerBuildWorkflow).not.toContain('- flake.nix')
    expect(arcRunnerBuildWorkflow).not.toContain('docker buildx')
    expect(arcRunnerBuildWorkflow).not.toContain('docker/setup-buildx-action')
    expect(arcRunnerBuildWorkflow).not.toContain('docker run')
    expect(arcRunnerBuildWorkflow).not.toContain("- '.github/actions/setup-nix-toolchain/**'")
    expect(arcRunnerBuildWorkflow).not.toContain("- '.github/workflows/nix-oci-build-common.yml'")
    expect(arcRunnerBuildWorkflow).not.toContain("- '.github/workflows/arc-runner-build-push.yml'")
    expect(arcRunnerBuildWorkflow).not.toContain("'.github/workflows/arc-runner-release.yml'")
    expect(arcRunnerBuildWorkflow).not.toContain("'packages/scripts/src/shared/__tests__/arc-runner.test.ts'")
    expect(arcRunnerReleaseWorkflow).toContain('workflows:')
    expect(arcRunnerReleaseWorkflow).toContain('arc-runner-build-push')
    expect(arcRunnerReleaseWorkflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
    expect(arcRunnerReleaseWorkflow).toContain("require-preinstalled: 'true'")
    expect(arcRunnerReleaseWorkflow).toContain('crane digest "${image}:${tag}"')
    expect(arcRunnerReleaseWorkflow).toContain('changed_paths="$(git diff --name-only "${source_sha}..HEAD")"')
    expect(arcRunnerReleaseWorkflow).toContain('arc_image_input_changes="$(')
    expect(arcRunnerReleaseWorkflow).toContain('ARC runner image inputs changed after the build:')
    expect(arcRunnerReleaseWorkflow).toContain('ARC runner image inputs unchanged after ${source_sha}')
    expect(arcRunnerBuildTriggerPaths.length).toBeGreaterThan(0)
    expect(arcRunnerToolchainScriptPaths.length).toBeGreaterThan(0)
    for (const toolchainScriptPath of arcRunnerToolchainScriptPaths) {
      if (arcRunnerReleaseOnlyScriptPaths.has(toolchainScriptPath)) {
        expect(
          arcRunnerBuildTriggerPaths,
          `${toolchainScriptPath} must not fan out ARC runner image builds`,
        ).not.toContain(toolchainScriptPath)
        continue
      }
      expect(arcRunnerBuildTriggerPaths, `${toolchainScriptPath} must start ARC runner image builds`).toContain(
        toolchainScriptPath,
      )
    }
    for (const arcImageInputPath of [
      ...arcRunnerBuildTriggerPaths,
      ...arcRunnerToolchainScriptPaths.filter((path) => !arcRunnerReleaseOnlyScriptPaths.has(path)),
    ]) {
      expect(arcRunnerReleaseWorkflow, `${arcImageInputPath} must block stale ARC runner promotion`).toContain(
        releaseGuardFragmentForPath(arcImageInputPath),
      )
    }
    expect(arcRunnerReleaseWorkflow).not.toContain('nix/oci-release-contract\\.sh')
    expect(arcRunnerReleaseWorkflow).not.toContain('flake\\.nix')
    expect(arcRunnerReleaseWorkflow).not.toContain('\\.github/workflows/arc-runner-release\\.yml')
    expect(arcRunnerReleaseWorkflow).toContain('nix run .#assert-oci-platforms')
    expect(arcRunnerReleaseWorkflow).not.toContain('docker buildx')
    expect(arcRunnerReleaseWorkflow).not.toContain('docker/setup-buildx-action')
    expect(arcRunnerReleaseWorkflow).toContain('peter-evans/create-pull-request@v7')
    expect(arcRunnerReleaseWorkflow).toContain('token: ${{ secrets.AGENTS_SPLIT_TOKEN || secrets.GITHUB_TOKEN }}')
    expect(arcRunnerReleaseWorkflow).toContain('argocd/applications/arc/application.yaml')
    expect(arcRunnerReleaseWorkflow).toContain('nix-oci')
  })

  it('uses a shared setup action so Nix jobs validate preinstalled tools before falling back', () => {
    expect(setupAction).toContain('Detect preinstalled Nix')
    expect(setupAction).toContain('require-preinstalled:')
    expect(setupAction).toContain('Reject missing preinstalled Nix')
    expect(setupAction).toContain("inputs.require-preinstalled == 'true'")
    expect(setupAction).toContain("steps.detect.outputs.nix_available != 'true'")
    expect(setupAction).toContain(
      "steps.detect.outputs.nix_available != 'true' && inputs.require-preinstalled != 'true'",
    )
    expect(setupAction).toContain('uses: cachix/install-nix-action@v31')
    expect(setupAction).toContain('extra_nix_config: ${{ inputs.extra-nix-config }}')
    expect(setupAction).toContain('NIX_CONFIG<<__LAB_NIX_CONFIG__')
    expect(setupAction).toContain('has_nixbld_group=false')
    expect(setupAction).toContain('getent group nixbld')
    expect(setupAction).toContain('build-users-group =')
    expect(setupAction).toContain('Validate writable Nix store access')
    expect(setupAction).toContain('nix store info')
    expect(setupAction).toContain('NIX_REMOTE=daemon')
    expect(setupAction).toContain('/nix/var/nix/daemon-socket/socket')
    expect(setupAction).toContain('lab-nix-sudo-wrapper')
    expect(setupAction).toContain('sudo -n --preserve-env=NIX_CONFIG,NIX_SSL_CERT_FILE')
    expect(setupAction).toContain('LAB_NIX_WITH_SUDO=true')
    expect(setupAction).toContain('neither daemon nor sudo store access is available')
    expect(setupAction).toContain('REQUIRE_PREINSTALLED: ${{ inputs.require-preinstalled }}')
    expect(setupAction).toContain('Required CI toolchain commands are missing from the preinstalled runner image')
    expect(setupAction).toContain('command -v "${cmd}"')
    expect(setupAction).toContain('node')
    expect(setupAction).toContain('bun')
    expect(setupAction).toContain('uv')
    expect(setupAction).toContain('buildctl')
    expect(setupAction).toContain('nix profile install .#ciToolchain --priority 4')
    expect(setupAction).toContain('toolchain-doctor')
    expect(setupAction).toContain('oci-doctor')

    for (const workflow of [
      nixOciWorkflow,
      atticReleaseWorkflow,
      agentsBuildWorkflow,
      enabledProductReleaseWorkflow,
      enabledSimpleReleaseWorkflow,
      headlampWorkflow,
      sagReleaseWorkflow,
      symphonyReleaseWorkflow,
    ]) {
      expect(workflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
      expect(workflow).toContain("require-preinstalled: 'true'")
    }

    for (const workflow of [argoLintWorkflow, kubeconformWorkflow, khoshutWorkflow]) {
      expect(workflow).toContain('runs-on: ubuntu-latest')
      expect(workflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
      expect(workflow).not.toContain("require-preinstalled: 'true'")
    }

    expect(nixOciWorkflow).not.toContain('Install xz for Nix installer')
    expect(nixOciWorkflow).not.toContain('uses: cachix/install-nix-action@v31')
    expect(atticReleaseWorkflow).not.toContain('Install xz for Nix installer')
    expect(atticReleaseWorkflow).not.toContain('uses: cachix/install-nix-action@v31')
  })

  it('does not let ARC workflow callers silently use fallback Nix installation', () => {
    const workflowDir = new URL('.github/workflows/', repoRoot)
    const arcSetupCallers = readdirSync(workflowDir)
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .map((file) => [file, readRepoFile(`.github/workflows/${file}`)] as const)
      .filter(([, content]) => content.includes('uses: ./.github/actions/setup-nix-toolchain'))
      .filter(([, content]) => content.includes('runs-on: arc-') || content.includes('runner: arc-'))

    expect(arcSetupCallers.length).toBeGreaterThan(0)
    for (const [file, content] of arcSetupCallers) {
      expect(content, `${file} must require the preinstalled ARC Nix toolchain`).toContain(
        "require-preinstalled: 'true'",
      )
    }
  })
})
