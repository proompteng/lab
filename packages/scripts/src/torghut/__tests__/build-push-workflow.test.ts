import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const workflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-build-push.yaml', import.meta.url),
  'utf8',
)
const taWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-ta-build-push.yaml', import.meta.url),
  'utf8',
)
const wsWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-ws-build-push.yaml', import.meta.url),
  'utf8',
)
const hyperliquidFeedWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-hyperliquid-feed-build-push.yaml', import.meta.url),
  'utf8',
)
const taReleaseWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-ta-release.yml', import.meta.url),
  'utf8',
)
const wsReleaseWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-ws-release.yml', import.meta.url),
  'utf8',
)
const hyperliquidFeedReleaseWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-hyperliquid-feed-release.yml', import.meta.url),
  'utf8',
)
const ciWorkflow = readFileSync(new URL('../../../../../.github/workflows/torghut-ci.yml', import.meta.url), 'utf8')
const pullRequestWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/pull-request.yml', import.meta.url),
  'utf8',
)
const arcApplication = readFileSync(
  new URL('../../../../../argocd/applications/arc/application.yaml', import.meta.url),
  'utf8',
)

const pathPatternIndex = (pattern: string): number =>
  workflow.split('\n').findIndex((line) => line.trim() === `- '${pattern}'`)

const ciPathPatternIndex = (pattern: string): number =>
  ciWorkflow.split('\n').findIndex((line) => line.trim() === `- '${pattern}'`)

const staleDiffBlockFor = (releaseWorkflow: string, markerPath: string): string => {
  const markerIndex = releaseWorkflow.indexOf(markerPath)
  if (markerIndex < 0) {
    throw new Error(`Missing stale diff marker path: ${markerPath}`)
  }

  const start = releaseWorkflow.lastIndexOf('git diff --name-only', markerIndex)
  const end = releaseWorkflow.indexOf(')"', markerIndex)
  if (start < 0 || end < 0) {
    throw new Error(`Missing stale diff block for: ${markerPath}`)
  }

  return releaseWorkflow.slice(start, end)
}

describe('torghut build-push workflow', () => {
  it('does not build the core Torghut image for release helper script changes', () => {
    expect(pathPatternIndex('packages/scripts/src/torghut/**')).toBe(-1)
    expect(pathPatternIndex('packages/scripts/src/torghut/update-hyperliquid-feed-manifest.ts')).toBe(-1)
    expect(pathPatternIndex('packages/scripts/src/shared/cli.ts')).toBe(-1)
    expect(pathPatternIndex('packages/scripts/src/shared/git.ts')).toBe(-1)
    expect(pathPatternIndex('.github/workflows/torghut-build-push.yaml')).toBe(-1)
    expect(pathPatternIndex('.github/workflows/nix-oci-build-common.yml')).toBe(-1)
    expect(pathPatternIndex('services/torghut/**')).toBeGreaterThan(-1)
    expect(pathPatternIndex('nix/images/torghut.nix')).toBeGreaterThan(-1)
  })

  it('does not run full Torghut service CI for the Hyperliquid feed release updater', () => {
    const scriptsInclude = ciPathPatternIndex('packages/scripts/src/torghut/**')
    const testsExclude = ciPathPatternIndex('!packages/scripts/src/torghut/__tests__/**')
    const testFilesExclude = ciPathPatternIndex('!packages/scripts/src/torghut/**/*.test.ts')
    const updaterExclude = ciPathPatternIndex('!packages/scripts/src/torghut/update-hyperliquid-feed-manifest.ts')

    expect(scriptsInclude).toBeGreaterThan(-1)
    expect(testsExclude).toBeGreaterThan(scriptsInclude)
    expect(testFilesExclude).toBeGreaterThan(scriptsInclude)
    expect(updaterExclude).toBeGreaterThan(scriptsInclude)
    expect(ciPathPatternIndex('.github/workflows/torghut-ci.yml')).toBe(-1)
    expect(ciPathPatternIndex('.github/workflows/torghut-build-push.yaml')).toBe(-1)
  })

  it('does not use actions/cache on the ARC-backed build runner', () => {
    expect(workflow).not.toContain('uses: actions/cache@v4')
  })

  it('routes the core Torghut image through the shared Nix OCI workflow', () => {
    expect(workflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(workflow).toContain('image_name: torghut')
    expect(workflow).toContain('package_attr: torghut-image')
    expect(workflow).toContain('tag: sha-${{ github.sha }}')
    expect(workflow).toContain('torghut-release-contract')
    expect(workflow).not.toContain('docker/setup-buildx-action')
    expect(workflow).not.toContain('docker/build-push-action')
    expect(workflow).not.toContain('docker buildx')
  })

  it('publishes and contracts the core Torghut image as amd64 and arm64', () => {
    const mainDispatchPredicate =
      "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'"

    expect(workflow).toContain(`latest: \${{ ${mainDispatchPredicate} }}`)
    expect(workflow).toContain(
      `release_artifact_name: \${{ ${mainDispatchPredicate} && 'torghut-release-contract' || '' }}`,
    )
  })

  it('publishes and contracts TA and WS images through the shared Nix OCI workflow', () => {
    const serviceWorkflows = [
      {
        workflow: taWorkflow,
        servicePath: 'services/dorvud/technical-analysis-flink/**',
        imageName: 'torghut-ta',
        packageAttr: 'torghut-ta-image',
        artifact: 'torghut-ta-release-contract',
      },
      {
        workflow: wsWorkflow,
        servicePath: 'services/dorvud/websockets/**',
        imageName: 'torghut-ws',
        packageAttr: 'torghut-ws-image',
        artifact: 'torghut-ws-release-contract',
      },
    ]

    for (const { workflow: serviceWorkflow, servicePath, imageName, packageAttr, artifact } of serviceWorkflows) {
      expect(serviceWorkflow).toContain('push:')
      expect(serviceWorkflow).toContain(`- '${servicePath}'`)
      expect(serviceWorkflow).toContain("- 'services/dorvud/platform/**'")
      expect(serviceWorkflow).toContain("- 'services/dorvud/settings.gradle.kts'")
      expect(serviceWorkflow).not.toContain("- 'services/dorvud/**'")
      expect(serviceWorkflow).not.toContain('workflow_run:')
      expect(serviceWorkflow).toContain("github.event_name == 'push'")
      expect(serviceWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
      expect(serviceWorkflow).toContain(`image_name: ${imageName}`)
      expect(serviceWorkflow).toContain(`package_attr: ${packageAttr}`)
      expect(serviceWorkflow).toContain(artifact)
      expect(serviceWorkflow).not.toContain('docker/setup-qemu-action')
      expect(serviceWorkflow).not.toContain('docker/setup-buildx-action')
      expect(serviceWorkflow).not.toContain('docker buildx')
    }
  })

  it('builds Hyperliquid feed images only for feed or shared Dorvud changes', () => {
    expect(hyperliquidFeedWorkflow).toContain('push:')
    expect(hyperliquidFeedWorkflow).toContain("- 'services/dorvud/hyperliquid-feed/**'")
    expect(hyperliquidFeedWorkflow).toContain("- 'services/dorvud/platform/**'")
    expect(hyperliquidFeedWorkflow).toContain("- 'services/dorvud/settings.gradle.kts'")
    expect(hyperliquidFeedWorkflow).toContain("- 'nix/oci-release-contract.sh'")
    expect(hyperliquidFeedWorkflow).not.toContain("- 'services/dorvud/**'")
    expect(hyperliquidFeedWorkflow).not.toContain('workflow_run:')
    expect(hyperliquidFeedWorkflow).toContain("github.event_name == 'push'")
    expect(hyperliquidFeedWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(hyperliquidFeedWorkflow).toContain('image_name: torghut-hyperliquid-feed')
    expect(hyperliquidFeedWorkflow).toContain('package_attr: torghut-hyperliquid-feed-image')
    expect(hyperliquidFeedWorkflow).toContain('torghut-hyperliquid-feed-release-contract')
    expect(hyperliquidFeedWorkflow).not.toContain('docker/setup-buildx-action')
    expect(hyperliquidFeedWorkflow).not.toContain('docker buildx')
  })

  it('promotes Hyperliquid feed images through a digest-pinned release PR', () => {
    expect(hyperliquidFeedReleaseWorkflow).toContain('workflow_run:')
    expect(hyperliquidFeedReleaseWorkflow).toContain('torghut-hyperliquid-feed-build-push')
    expect(hyperliquidFeedReleaseWorkflow).toContain('name: torghut-hyperliquid-feed-release-contract')
    expect(hyperliquidFeedReleaseWorkflow).toContain("IMAGE='registry.ide-newton.ts.net/lab/torghut-hyperliquid-feed'")
    expect(hyperliquidFeedReleaseWorkflow).toContain(
      'bun run packages/scripts/src/torghut/update-hyperliquid-feed-manifest.ts',
    )
    expect(hyperliquidFeedReleaseWorkflow).toContain('argocd/applications/torghut-hyperliquid-feed/deployment.yaml')
    expect(hyperliquidFeedReleaseWorkflow).toContain(
      'branch: codex/torghut-hyperliquid-feed-release-${{ steps.meta.outputs.tag }}',
    )
  })

  it('defines native amd64 and arm64 GitHub runner scale sets for Torghut image builds', () => {
    expect(arcApplication).toContain('runnerScaleSetName: arc-amd64')
    expect(arcApplication).toContain('- arc-amd64')
    expect(arcApplication).toContain('kubernetes.io/arch: amd64')
    expect(arcApplication).toContain('runnerScaleSetName: arc-arm64')
    expect(arcApplication).toContain('- arc-arm64')
    expect(arcApplication).toContain('kubernetes.io/arch: arm64')
  })

  it('keeps manifest-only release CI free of package install overhead', () => {
    const releaseManifestJob = ciWorkflow.indexOf('release-manifests:')
    const nextJob = ciWorkflow.indexOf('\n  pyright:', releaseManifestJob)
    const releaseManifestJobBody = ciWorkflow.slice(releaseManifestJob, nextJob)

    expect(releaseManifestJob).toBeGreaterThan(-1)
    expect(releaseManifestJobBody).toContain('name: Verify source image digest contract')
    expect(releaseManifestJobBody).toContain('TORGHUT_COMMIT')
    expect(releaseManifestJobBody).toContain('TORGHUT_TA_COMMIT')
    expect(releaseManifestJobBody).toContain('TORGHUT_WS_COMMIT')
    expect(releaseManifestJobBody).not.toContain('oven-sh/setup-bun')
    expect(releaseManifestJobBody).not.toContain('actions/cache@v4')
    expect(releaseManifestJobBody).not.toContain('bun install')
  })

  it('authenticates changed-file planner GitHub API calls', () => {
    const changesJob = ciWorkflow.indexOf('changes:')
    const tokenEnv = ciWorkflow.indexOf('GH_TOKEN: ${{ github.token }}', changesJob)
    const authHeader = ciWorkflow.indexOf('-H "Authorization: Bearer ${GH_TOKEN}"', tokenEnv)
    const prFilesCall = ciWorkflow.indexOf('/pulls/${PR_NUMBER}/files?per_page=100&page=${page}', authHeader)
    const compareCall = ciWorkflow.indexOf('/compare/${BEFORE_SHA}...${HEAD_SHA}', authHeader)

    expect(changesJob).toBeGreaterThan(-1)
    expect(tokenEnv).toBeGreaterThan(changesJob)
    expect(authHeader).toBeGreaterThan(tokenEnv)
    expect(prFilesCall).toBeGreaterThan(authHeader)
    expect(compareCall).toBeGreaterThan(authHeader)
  })

  it('retries generic pull-request changed-file planner GitHub API calls', () => {
    const changesJob = pullRequestWorkflow.indexOf('check_changed_files:')
    const tokenEnv = pullRequestWorkflow.indexOf('GH_TOKEN: ${{ github.token }}', changesJob)
    const retryCurl = pullRequestWorkflow.indexOf('curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors', tokenEnv)
    const authHeader = pullRequestWorkflow.indexOf('-H "Authorization: Bearer ${GH_TOKEN}"', retryCurl)
    const prFilesCall = pullRequestWorkflow.indexOf('/pulls/${PR_NUMBER}/files?per_page=100&page=${page}', authHeader)

    expect(changesJob).toBeGreaterThan(-1)
    expect(tokenEnv).toBeGreaterThan(changesJob)
    expect(retryCurl).toBeGreaterThan(tokenEnv)
    expect(authHeader).toBeGreaterThan(retryCurl)
    expect(prFilesCall).toBeGreaterThan(authHeader)
  })

  it('gates release manifest-only CI on digest-pinned multi-arch image contracts', () => {
    const releaseManifestJob = ciWorkflow.indexOf('release-manifests:')
    const buildContractStep = ciWorkflow.indexOf('name: Verify source image digest contract', releaseManifestJob)
    const releaseManifestJobBody = ciWorkflow.slice(
      releaseManifestJob,
      ciWorkflow.indexOf('\n  pyright:', releaseManifestJob),
    )

    expect(buildContractStep).toBeGreaterThan(releaseManifestJob)
    expect(releaseManifestJobBody).toContain('runs-on: arc-arm64')
    expect(releaseManifestJobBody).toContain('registry.ide-newton.ts.net, which is only')
    expect(releaseManifestJobBody).toContain('argocd/applications/torghut/knative-service.yaml')
    expect(releaseManifestJobBody).toContain('argocd/applications/torghut/ta/flinkdeployment.yaml')
    expect(releaseManifestJobBody).toContain('argocd/applications/torghut/ws/deployment.yaml')
    expect(releaseManifestJobBody).toContain('registry.ide-newton.ts.net/lab/torghut')
    expect(releaseManifestJobBody).toContain('registry.ide-newton.ts.net/lab/torghut-ta')
    expect(releaseManifestJobBody).toContain('registry.ide-newton.ts.net/lab/torghut-ws')
    expect(releaseManifestJobBody).toContain('uses: ./.github/actions/setup-nix-toolchain')
    expect(releaseManifestJobBody).toContain('nix run .#assert-oci-platforms -- "${image_ref}" linux/amd64 linux/arm64')
    expect(releaseManifestJobBody).not.toContain('docker buildx')
    expect(releaseManifestJobBody).toContain('release manifest pins a multi-arch image digest')
    expect(releaseManifestJobBody).not.toContain('gh run list')
    expect(releaseManifestJobBody).not.toContain('gh run view')
    expect(ciWorkflow).not.toContain('name: Require source commit Torghut CI')
    expect(ciWorkflow).not.toContain('--workflow torghut-ci.yml')
  })

  it('shards the expensive autoresearch runner tests in Torghut CI', () => {
    const autoresearchJob = ciWorkflow.indexOf('pytest-autoresearch-runner:')
    const nextJob = ciWorkflow.indexOf('\n  lint-and-tests:', autoresearchJob)
    const autoresearchJobBody = ciWorkflow.slice(autoresearchJob, nextJob)

    expect(autoresearchJob).toBeGreaterThan(-1)
    expect(autoresearchJobBody).toContain('name: Pytest autoresearch runner ${{ matrix.shard }}')
    expect(autoresearchJobBody).toContain('shard: [0, 1, 2, 3]')
    expect(autoresearchJobBody).toContain('SHARD_TOTAL: 4')
    expect(autoresearchJobBody).toContain('uv run --frozen pytest --collect-only -q tests/autoresearch_runner')
    expect(autoresearchJobBody).toContain('EXPECTED_COUNT_MISMATCH:%d')
    expect(autoresearchJobBody).toContain('name: torghut-coverage-autoresearch-runner-${{ matrix.shard }}')
    expect(autoresearchJobBody).not.toContain('name: torghut-coverage-autoresearch-runner\n')
  })

  it('shards primary Torghut pytest by collected test node instead of file list', () => {
    const pytestShardJob = ciWorkflow.indexOf('pytest-shards:')
    const nextJob = ciWorkflow.indexOf('\n  pytest-autoresearch-runner:', pytestShardJob)
    const pytestShardJobBody = ciWorkflow.slice(pytestShardJob, nextJob)

    expect(pytestShardJob).toBeGreaterThan(-1)
    expect(pytestShardJobBody).toContain('name: Pytest shard ${{ matrix.shard }}')
    expect(pytestShardJobBody).toContain('shard: [0, 1, 2, 3, 4, 5, 6, 7]')
    expect(pytestShardJobBody).toContain('SHARD_TOTAL: 8')
    expect(pytestShardJobBody).toContain(
      'uv run --frozen pytest --collect-only -q tests --ignore=tests/autoresearch_runner',
    )
    expect(pytestShardJobBody).toContain('EXPECTED_MIN_COUNT_MISMATCH:%d')
    expect(pytestShardJobBody).toContain('"${TEST_NODES[@]}"')
    expect(pytestShardJobBody).not.toContain("find tests -name 'test_*.py'")
    expect(pytestShardJobBody).not.toContain('"${TEST_FILES[@]}"')
  })

  it('keeps TA and WS stale workflow promotions path-aware so unrelated main commits do not force rebuilds', () => {
    const releaseWorkflows = [
      {
        workflow: taReleaseWorkflow,
        servicePath: 'services/dorvud/technical-analysis-flink',
        message: 'newer Torghut TA build inputs changed',
      },
      {
        workflow: wsReleaseWorkflow,
        servicePath: 'services/dorvud/websockets',
        message: 'newer Torghut WS build inputs changed',
      },
    ]

    for (const { workflow, servicePath, message } of releaseWorkflows) {
      const staleDiffBlock = staleDiffBlockFor(workflow, servicePath)

      expect(workflow).toContain('git merge-base --is-ancestor "${SOURCE_SHA}" "${MAIN_HEAD}"')
      expect(workflow).toContain('git diff --name-only "${SOURCE_SHA}..${MAIN_HEAD}" --')
      expect(staleDiffBlock).toContain(servicePath)
      expect(staleDiffBlock).toContain('services/dorvud/platform')
      expect(staleDiffBlock).toContain('nix/cache-push.sh')
      expect(staleDiffBlock).toContain('nix/ci-nix-oci-summary.sh')
      expect(staleDiffBlock).toContain('nix/ci-run-timed.sh')
      expect(staleDiffBlock).toContain('nix/oci-inspect-archive.sh')
      expect(staleDiffBlock).toContain('nix/oci-push.sh')
      expect(staleDiffBlock).toContain('nix/oci-release-contract.sh')
      expect(staleDiffBlock).toContain('flake.lock')
      expect(staleDiffBlock).not.toContain('.github/workflows/')
      expect(staleDiffBlock).not.toContain('packages/scripts/src/torghut/release-contract.ts')
      expect(staleDiffBlock).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
      expect(staleDiffBlock).not.toContain('packages/scripts/src/shared/oci-digest.ts')
      expect(workflow).toContain(message)
      expect(workflow).toContain('newer main ${MAIN_HEAD} contains only unrelated changes')
    }
  })

  it('keeps Hyperliquid feed stale workflow promotions path-aware so unrelated main commits do not block release', () => {
    const staleDiffBlock = staleDiffBlockFor(hyperliquidFeedReleaseWorkflow, 'services/dorvud/hyperliquid-feed')

    expect(hyperliquidFeedReleaseWorkflow).toContain('git merge-base --is-ancestor "${SOURCE_SHA}" "${MAIN_HEAD}"')
    expect(hyperliquidFeedReleaseWorkflow).toContain('git diff --name-only "${SOURCE_SHA}..${MAIN_HEAD}" --')
    expect(staleDiffBlock).toContain('services/dorvud/hyperliquid-feed')
    expect(staleDiffBlock).toContain('services/dorvud/platform')
    expect(staleDiffBlock).toContain('nix/cache-push.sh')
    expect(staleDiffBlock).toContain('nix/ci-nix-oci-summary.sh')
    expect(staleDiffBlock).toContain('nix/ci-run-timed.sh')
    expect(staleDiffBlock).toContain('nix/oci-inspect-archive.sh')
    expect(staleDiffBlock).toContain('nix/oci-push.sh')
    expect(staleDiffBlock).toContain('nix/oci-release-contract.sh')
    expect(staleDiffBlock).toContain('flake.lock')
    expect(staleDiffBlock).not.toContain('.github/workflows/')
    expect(staleDiffBlock).not.toContain('packages/scripts/src/torghut/release-contract.ts')
    expect(staleDiffBlock).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
    expect(staleDiffBlock).not.toContain('packages/scripts/src/shared/oci-digest.ts')
    expect(hyperliquidFeedReleaseWorkflow).toContain('newer Hyperliquid feed build inputs changed')
    expect(hyperliquidFeedReleaseWorkflow).toContain('newer main ${MAIN_HEAD} contains only unrelated changes')
  })

  it('does not cancel main source CI while release promotion verifies the image contract', () => {
    expect(ciWorkflow).toContain(
      "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}",
    )
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}")
  })
})
