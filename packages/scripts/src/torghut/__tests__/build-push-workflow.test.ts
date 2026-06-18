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
    expect(hyperliquidFeedWorkflow).not.toContain("- 'services/dorvud/**'")
    expect(hyperliquidFeedWorkflow).not.toContain('workflow_run:')
    expect(hyperliquidFeedWorkflow).toContain("github.event_name == 'push'")
    expect(hyperliquidFeedWorkflow).toContain('runner: arc-amd64')
    expect(hyperliquidFeedWorkflow).toContain('runner: arc-arm64')
    expect(hyperliquidFeedWorkflow).toContain('platforms: ${{ matrix.platform }}')
    expect(hyperliquidFeedWorkflow).toContain('name: Verify multi-arch image manifest')
    expect(hyperliquidFeedWorkflow).toContain('for platform in linux/amd64 linux/arm64; do')
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
    expect(releaseManifestJobBody).toContain('name: Verify source image build contract')
    expect(releaseManifestJobBody).toContain('TORGHUT_COMMIT')
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

  it('gates release manifest-only CI on the completed build-push image contract', () => {
    const releaseManifestJob = ciWorkflow.indexOf('release-manifests:')
    const buildContractStep = ciWorkflow.indexOf('name: Verify source image build contract', releaseManifestJob)

    expect(buildContractStep).toBeGreaterThan(releaseManifestJob)
    expect(ciWorkflow).toContain('--workflow torghut-build-push.yaml')
    expect(ciWorkflow).toContain('build-platform (linux/amd64, amd64, arc-amd64)')
    expect(ciWorkflow).toContain('build-platform (linux/arm64, arm64, arc-arm64)')
    expect(ciWorkflow).toContain('publish-index')
    expect(ciWorkflow).toContain('Torghut build-push passed required image contract jobs')
    expect(ciWorkflow).not.toContain('name: Require source commit Torghut CI')
    expect(ciWorkflow).not.toContain('--workflow torghut-ci.yml')
  })

  it('does not cancel main source CI while release promotion verifies the image contract', () => {
    expect(ciWorkflow).toContain(
      "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}",
    )
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}")
  })
})
