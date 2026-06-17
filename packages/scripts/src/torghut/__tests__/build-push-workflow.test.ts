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
const ciWorkflow = readFileSync(new URL('../../../../../.github/workflows/torghut-ci.yml', import.meta.url), 'utf8')
const pullRequestWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/pull-request.yml', import.meta.url),
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
    const buildJob = workflow.indexOf('build-and-push:')
    const cacheStep = workflow.indexOf('uses: actions/cache@v4', buildJob)

    expect(buildJob).toBeGreaterThan(-1)
    expect(cacheStep).toBe(-1)
  })

  it('waits for the private registry before building the release image', () => {
    const buildJob = workflow.indexOf('build-and-push:')
    const registryWaitStep = workflow.indexOf('name: Wait for private registry', buildJob)
    const buildStep = workflow.indexOf('name: Build and push torghut image', buildJob)

    expect(workflow).toContain('timeout-minutes: 180')
    expect(registryWaitStep).toBeGreaterThan(buildJob)
    expect(buildStep).toBeGreaterThan(registryWaitStep)
    expect(workflow).toContain('REGISTRY_URL: https://registry.ide-newton.ts.net/v2/')
    expect(workflow).toContain('REGISTRY_WAIT_TIMEOUT_SECONDS: 7200')
  })

  it('publishes and contracts the core Torghut image as amd64 and arm64', () => {
    expect(workflow).toContain('TORGHUT_IMAGE_PLATFORMS: linux/amd64,linux/arm64')
    expect(workflow).not.toContain('docker/setup-qemu-action')
    expect(workflow).toContain('name: Verify multi-arch image manifest')
    expect(workflow).toContain('for platform in linux/amd64 linux/arm64; do')
    expect(workflow).toContain("--platforms 'linux/amd64,linux/arm64'")
    expect(workflow).toContain("--platform-digest 'linux/amd64=${{ steps.digest.outputs.platform_digest_amd64 }}'")
    expect(workflow).toContain("--platform-digest 'linux/arm64=${{ steps.digest.outputs.platform_digest_arm64 }}'")
  })

  it('publishes and contracts TA and WS images as amd64 and arm64 from direct pushes', () => {
    for (const serviceWorkflow of [taWorkflow, wsWorkflow]) {
      expect(serviceWorkflow).toContain('push:')
      expect(serviceWorkflow).toContain("- 'services/dorvud/**'")
      expect(serviceWorkflow).toContain("github.event_name == 'push'")
      expect(serviceWorkflow).not.toContain('docker/setup-qemu-action')
      expect(serviceWorkflow).toContain('platforms: linux/amd64,linux/arm64')
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

  it('caches Bun downloads before manifest-only CI installs script dependencies', () => {
    const releaseManifestJob = ciWorkflow.indexOf('release-manifests:')
    const cacheStep = ciWorkflow.indexOf('name: Cache Bun downloads', releaseManifestJob)
    const cachePath = ciWorkflow.indexOf('path: ~/.bun/install/cache', cacheStep)
    const installStep = ciWorkflow.indexOf('name: Install script dependencies', cachePath)

    expect(releaseManifestJob).toBeGreaterThan(-1)
    expect(cacheStep).toBeGreaterThan(releaseManifestJob)
    expect(cachePath).toBeGreaterThan(cacheStep)
    expect(installStep).toBeGreaterThan(cachePath)
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

  it('does not cancel main source CI that release promotion must verify', () => {
    expect(ciWorkflow).toContain(
      "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}",
    )
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}")
  })
})
