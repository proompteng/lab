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

describe('torghut build-push workflow', () => {
  it('does not build and deploy Torghut for test-only script changes', () => {
    const scriptsInclude = pathPatternIndex('packages/scripts/src/torghut/**')
    const testsExclude = pathPatternIndex('!packages/scripts/src/torghut/__tests__/**')
    const testFilesExclude = pathPatternIndex('!packages/scripts/src/torghut/**/*.test.ts')

    expect(scriptsInclude).toBeGreaterThan(-1)
    expect(testsExclude).toBeGreaterThan(scriptsInclude)
    expect(testFilesExclude).toBeGreaterThan(scriptsInclude)
  })

  it('does not use actions/cache on the ARC-backed build runner', () => {
    const buildJob = workflow.indexOf('build-platform:')
    const cacheStep = workflow.indexOf('uses: actions/cache@v4', buildJob)

    expect(buildJob).toBeGreaterThan(-1)
    expect(cacheStep).toBe(-1)
  })

  it('waits for the private registry before building the release image', () => {
    const buildJob = workflow.indexOf('build-platform:')
    const registryWaitStep = workflow.indexOf('name: Wait for private registry', buildJob)
    const buildStep = workflow.indexOf('name: Build and push torghut image', buildJob)

    expect(buildJob).toBeGreaterThan(-1)
    expect(workflow).toContain('timeout-minutes: 180')
    expect(registryWaitStep).toBeGreaterThan(buildJob)
    expect(buildStep).toBeGreaterThan(registryWaitStep)
    expect(workflow).toContain('REGISTRY_URL: https://registry.ide-newton.ts.net/v2/')
    expect(workflow).toContain('REGISTRY_WAIT_TIMEOUT_SECONDS: 7200')
  })

  it('publishes and contracts the core Torghut image as amd64 and arm64', () => {
    expect(workflow).toContain('runner: arc-amd64')
    expect(workflow).toContain('runner: arc-arm64')
    expect(workflow).toContain('runs-on: ${{ matrix.runner }}')
    expect(workflow).toContain('TORGHUT_IMAGE_TAG: ${{ steps.meta.outputs.tag }}-${{ matrix.arch }}')
    expect(workflow).toContain('TORGHUT_IMAGE_PLATFORMS: ${{ matrix.platform }}')
    expect(workflow).not.toContain('docker/setup-qemu-action')
    expect(workflow).toContain('name: Create multi-arch image index')
    expect(workflow).toContain('"${IMAGE}:${TAG}-amd64"')
    expect(workflow).toContain('"${IMAGE}:${TAG}-arm64"')
    expect(workflow).toContain('name: Verify multi-arch image manifest')
    expect(workflow).toContain('for platform in linux/amd64 linux/arm64; do')
    expect(workflow).toContain("--platforms 'linux/amd64,linux/arm64'")
    expect(workflow).toContain("--platform-digest 'linux/amd64=${{ steps.digest.outputs.platform_digest_amd64 }}'")
    expect(workflow).toContain("--platform-digest 'linux/arm64=${{ steps.digest.outputs.platform_digest_arm64 }}'")
  })

  it('publishes and contracts TA and WS images as amd64 and arm64 from direct pushes', () => {
    const serviceWorkflows = [
      {
        workflow: taWorkflow,
        servicePath: 'services/dorvud/technical-analysis-flink/**',
      },
      {
        workflow: wsWorkflow,
        servicePath: 'services/dorvud/websockets/**',
      },
    ]

    for (const { workflow: serviceWorkflow, servicePath } of serviceWorkflows) {
      expect(serviceWorkflow).toContain('push:')
      expect(serviceWorkflow).toContain(`- '${servicePath}'`)
      expect(serviceWorkflow).toContain("- 'services/dorvud/platform/**'")
      expect(serviceWorkflow).toContain("- 'services/dorvud/settings.gradle.kts'")
      expect(serviceWorkflow).not.toContain("- 'services/dorvud/**'")
      expect(serviceWorkflow).not.toContain('workflow_run:')
      expect(serviceWorkflow).toContain("github.event_name == 'push'")
      expect(serviceWorkflow).toContain('runner: arc-amd64')
      expect(serviceWorkflow).toContain('runner: arc-arm64')
      expect(serviceWorkflow).toContain('runs-on: ${{ matrix.runner }}')
      expect(serviceWorkflow).not.toContain('docker/setup-qemu-action')
      expect(serviceWorkflow).toContain('platforms: ${{ matrix.platform }}')
      expect(serviceWorkflow).toContain(':${{ steps.meta.outputs.tag }}-${{ matrix.arch }}')
      expect(serviceWorkflow).toContain(':latest-${{ matrix.arch }}')
      expect(serviceWorkflow).toContain('name: Create multi-arch image index')
      expect(serviceWorkflow).toContain('"${IMAGE}:${TAG}-amd64"')
      expect(serviceWorkflow).toContain('"${IMAGE}:${TAG}-arm64"')
      expect(serviceWorkflow).toContain('name: Verify multi-arch image manifest')
      expect(serviceWorkflow).toContain('for platform in linux/amd64 linux/arm64; do')
      expect(serviceWorkflow).toContain("--platforms 'linux/amd64,linux/arm64'")
      expect(serviceWorkflow).toContain(
        "--platform-digest 'linux/amd64=${{ steps.digest.outputs.platform_digest_amd64 }}'",
      )
      expect(serviceWorkflow).toContain(
        "--platform-digest 'linux/arm64=${{ steps.digest.outputs.platform_digest_arm64 }}'",
      )
    }
  })

  it('builds Hyperliquid feed images only for feed or shared Dorvud changes', () => {
    expect(hyperliquidFeedWorkflow).toContain('push:')
    expect(hyperliquidFeedWorkflow).toContain("- 'services/dorvud/hyperliquid-feed/**'")
    expect(hyperliquidFeedWorkflow).toContain("- 'services/dorvud/platform/**'")
    expect(hyperliquidFeedWorkflow).toContain("- 'services/dorvud/settings.gradle.kts'")
    expect(hyperliquidFeedWorkflow).toContain("- 'packages/scripts/src/torghut/release-contract.ts'")
    expect(hyperliquidFeedWorkflow).not.toContain("- 'services/dorvud/**'")
    expect(hyperliquidFeedWorkflow).not.toContain('workflow_run:')
    expect(hyperliquidFeedWorkflow).toContain("github.event_name == 'push'")
    expect(hyperliquidFeedWorkflow).toContain('runner: arc-amd64')
    expect(hyperliquidFeedWorkflow).toContain('runner: arc-arm64')
    expect(hyperliquidFeedWorkflow).toContain('platforms: ${{ matrix.platform }}')
    expect(hyperliquidFeedWorkflow).toContain('name: Verify multi-arch image manifest')
    expect(hyperliquidFeedWorkflow).toContain('for platform in linux/amd64 linux/arm64; do')
    expect(hyperliquidFeedWorkflow).toContain('name: Write release contract artifact')
    expect(hyperliquidFeedWorkflow).toContain('--path torghut-hyperliquid-feed-release-contract.json')
    expect(hyperliquidFeedWorkflow).toContain("--image 'registry.ide-newton.ts.net/lab/torghut-hyperliquid-feed'")
    expect(hyperliquidFeedWorkflow).toContain('name: torghut-hyperliquid-feed-release-contract')
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
    expect(releaseManifestJobBody).toContain('docker buildx imagetools inspect')
    expect(releaseManifestJobBody).toContain('for platform in linux/amd64 linux/arm64; do')
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

  it('keeps TA and WS stale workflow promotions path-aware so unrelated main commits do not force rebuilds', () => {
    const releaseWorkflows = [
      {
        workflow: taReleaseWorkflow,
        workflowPath: '.github/workflows/torghut-ta-release.yml',
        buildPath: '.github/workflows/torghut-ta-build-push.yaml',
        updateScript: 'packages/scripts/src/torghut/update-ta-manifest.ts',
        servicePath: 'services/dorvud/technical-analysis-flink',
        message: 'newer Torghut TA build inputs changed',
      },
      {
        workflow: wsReleaseWorkflow,
        workflowPath: '.github/workflows/torghut-ws-release.yml',
        buildPath: '.github/workflows/torghut-ws-build-push.yaml',
        updateScript: 'packages/scripts/src/torghut/update-ws-manifest.ts',
        servicePath: 'services/dorvud/websockets',
        message: 'newer Torghut WS build inputs changed',
      },
    ]

    for (const { workflow, workflowPath, buildPath, updateScript, servicePath, message } of releaseWorkflows) {
      expect(workflow).toContain('git merge-base --is-ancestor "${SOURCE_SHA}" "${MAIN_HEAD}"')
      expect(workflow).toContain('git diff --name-only "${SOURCE_SHA}..${MAIN_HEAD}" --')
      expect(workflow).toContain(servicePath)
      expect(workflow).toContain('services/dorvud/platform')
      expect(workflow).toContain('packages/scripts/src/torghut/release-contract.ts')
      expect(workflow).toContain(updateScript)
      expect(workflow).toContain(buildPath)
      expect(workflow).toContain(workflowPath)
      expect(workflow).toContain(message)
      expect(workflow).toContain('newer main ${MAIN_HEAD} contains only unrelated changes')
    }
  })

  it('keeps Hyperliquid feed stale workflow promotions path-aware so unrelated main commits do not block release', () => {
    expect(hyperliquidFeedReleaseWorkflow).toContain('git merge-base --is-ancestor "${SOURCE_SHA}" "${MAIN_HEAD}"')
    expect(hyperliquidFeedReleaseWorkflow).toContain('git diff --name-only "${SOURCE_SHA}..${MAIN_HEAD}" --')
    expect(hyperliquidFeedReleaseWorkflow).toContain('services/dorvud/hyperliquid-feed')
    expect(hyperliquidFeedReleaseWorkflow).toContain('services/dorvud/platform')
    expect(hyperliquidFeedReleaseWorkflow).toContain('packages/scripts/src/torghut/release-contract.ts')
    expect(hyperliquidFeedReleaseWorkflow).toContain('packages/scripts/src/torghut/update-hyperliquid-feed-manifest.ts')
    expect(hyperliquidFeedReleaseWorkflow).toContain('packages/scripts/src/shared/cli.ts')
    expect(hyperliquidFeedReleaseWorkflow).toContain('packages/scripts/src/shared/docker.ts')
    expect(hyperliquidFeedReleaseWorkflow).toContain('packages/scripts/src/shared/git.ts')
    expect(hyperliquidFeedReleaseWorkflow).toContain('.github/workflows/torghut-hyperliquid-feed-build-push.yaml')
    expect(hyperliquidFeedReleaseWorkflow).toContain('.github/workflows/torghut-hyperliquid-feed-release.yml')
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
