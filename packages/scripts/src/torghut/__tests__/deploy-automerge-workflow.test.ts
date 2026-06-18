import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

const releaseWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-release.yml', import.meta.url),
  'utf8',
)
const deployAutomergeWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-deploy-automerge.yml', import.meta.url),
  'utf8',
)

const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

describe('torghut-deploy-automerge workflow', () => {
  test('allowlists every hyperliquid runtime manifest promoted by torghut-release', () => {
    const promotedHyperliquidRuntimeManifests = [
      'argocd/applications/torghut-hyperliquid-runtime/deployment.yaml',
      'argocd/applications/torghut-hyperliquid-runtime/db-migrations-job.yaml',
    ]

    for (const manifestPath of promotedHyperliquidRuntimeManifests) {
      expect(releaseWorkflow).toContain(manifestPath)
      expect(countOccurrences(deployAutomergeWorkflow, `'${manifestPath}'`)).toBeGreaterThanOrEqual(2)
    }
  })

  test('verifies the source build-push image contract instead of waiting for full source CI', () => {
    expect(deployAutomergeWorkflow).toContain('name: Verify source image build contract')
    expect(deployAutomergeWorkflow).toContain('--workflow torghut-build-push.yaml')
    expect(deployAutomergeWorkflow).toContain('build-platform (linux/amd64, amd64, arc-amd64)')
    expect(deployAutomergeWorkflow).toContain('build-platform (linux/arm64, arm64, arc-arm64)')
    expect(deployAutomergeWorkflow).toContain('publish-index')
    expect(deployAutomergeWorkflow).toContain('Torghut build-push passed required image contract jobs')
    expect(deployAutomergeWorkflow).not.toContain('name: Wait for source commit Torghut CI')
    expect(deployAutomergeWorkflow).not.toContain('--workflow torghut-ci.yml')
  })
})
