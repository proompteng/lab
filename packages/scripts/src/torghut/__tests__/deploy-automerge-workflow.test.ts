import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

const releaseWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-release.yml', import.meta.url),
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

  test('allowlists TA and WS promotion manifests for automatic release PR merges', () => {
    const promotedTaManifests = [
      'argocd/applications/torghut/ta/flinkdeployment.yaml',
      'argocd/applications/torghut/ta-sim/flinkdeployment.yaml',
      'argocd/applications/torghut-options/ta/flinkdeployment.yaml',
    ]
    const promotedWsManifests = [
      'argocd/applications/torghut/ws/deployment.yaml',
      'argocd/applications/torghut-options/ws/deployment.yaml',
    ]

    for (const manifestPath of promotedTaManifests) {
      expect(taReleaseWorkflow).toContain(manifestPath)
      expect(countOccurrences(deployAutomergeWorkflow, `'${manifestPath}'`)).toBeGreaterThanOrEqual(2)
    }
    for (const manifestPath of promotedWsManifests) {
      expect(wsReleaseWorkflow).toContain(manifestPath)
      expect(countOccurrences(deployAutomergeWorkflow, `'${manifestPath}'`)).toBeGreaterThanOrEqual(2)
    }
  })

  test('verifies the matching source build-push image contract instead of waiting for full source CI', () => {
    expect(deployAutomergeWorkflow).toContain('name: Verify source image build contract')
    expect(deployAutomergeWorkflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'codex/torghut-release-')",
    )
    expect(deployAutomergeWorkflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'codex/torghut-ta-release-')",
    )
    expect(deployAutomergeWorkflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'codex/torghut-ws-release-')",
    )
    expect(deployAutomergeWorkflow).toContain("build_workflow='torghut-build-push.yaml'")
    expect(deployAutomergeWorkflow).toContain("build_workflow='torghut-ta-build-push.yaml'")
    expect(deployAutomergeWorkflow).toContain("build_workflow='torghut-ws-build-push.yaml'")
    expect(deployAutomergeWorkflow).toContain("source_env_name='TORGHUT_COMMIT'")
    expect(deployAutomergeWorkflow).toContain("source_env_name='TORGHUT_TA_COMMIT'")
    expect(deployAutomergeWorkflow).toContain("source_env_name='TORGHUT_WS_COMMIT'")
    expect(deployAutomergeWorkflow).toContain('build-platform (linux/amd64, amd64, arc-amd64)')
    expect(deployAutomergeWorkflow).toContain('build-platform (linux/arm64, arm64, arc-arm64)')
    expect(deployAutomergeWorkflow).toContain('publish-index')
    expect(deployAutomergeWorkflow).toContain('build-push passed required image contract jobs')
    expect(deployAutomergeWorkflow).not.toContain('name: Wait for source commit Torghut CI')
    expect(deployAutomergeWorkflow).not.toContain('--workflow torghut-ci.yml')
  })
})
