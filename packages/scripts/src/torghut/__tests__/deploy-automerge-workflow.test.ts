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
})
