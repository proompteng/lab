import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const workflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-build-push.yaml', import.meta.url),
  'utf8',
)
const ciWorkflow = readFileSync(new URL('../../../../../.github/workflows/torghut-ci.yml', import.meta.url), 'utf8')
const releaseWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-release.yml', import.meta.url),
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

  it('caches Bun downloads before installing script dependencies', () => {
    const cacheStep = workflow.indexOf('name: Cache Bun downloads')
    const cachePath = workflow.indexOf('path: ~/.bun/install/cache')
    const installStep = workflow.indexOf('name: Install dependencies')

    expect(cacheStep).toBeGreaterThan(-1)
    expect(cachePath).toBeGreaterThan(cacheStep)
    expect(installStep).toBeGreaterThan(cachePath)
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

  it('caches Bun downloads before release workflow runs Torghut scripts', () => {
    const cacheStep = releaseWorkflow.indexOf('name: Cache Bun downloads')
    const cachePath = releaseWorkflow.indexOf('path: ~/.bun/install/cache')
    const resolveStep = releaseWorkflow.indexOf('name: Resolve release metadata')

    expect(cacheStep).toBeGreaterThan(-1)
    expect(cachePath).toBeGreaterThan(cacheStep)
    expect(resolveStep).toBeGreaterThan(cachePath)
  })
})
