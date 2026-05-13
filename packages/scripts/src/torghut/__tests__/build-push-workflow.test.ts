import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const workflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-build-push.yaml', import.meta.url),
  'utf8',
)
const ciWorkflow = readFileSync(new URL('../../../../../.github/workflows/torghut-ci.yml', import.meta.url), 'utf8')

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

  it('does not cancel main source CI that release promotion must verify', () => {
    expect(ciWorkflow).toContain(
      "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}",
    )
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}")
  })
})
