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
const hyperliquidFeedReleaseWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-hyperliquid-feed-release.yml', import.meta.url),
  'utf8',
)

const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

describe('torghut-deploy-automerge workflow', () => {
  test('runs registry digest validation where the private registry is reachable', () => {
    expect(deployAutomergeWorkflow).toContain('runs-on: arc-amd64')
    expect(deployAutomergeWorkflow).not.toContain('runs-on: arc-arm64')
    expect(deployAutomergeWorkflow).not.toContain('runs-on: ubuntu-latest')
    expect(deployAutomergeWorkflow).toContain(
      'This pull_request_target job checks out trusted base code only, never pull request code.',
    )
    expect(deployAutomergeWorkflow).toContain('uses: actions/checkout@v4')
    expect(deployAutomergeWorkflow).toContain('ref: ${{ github.event.pull_request.base.sha }}')
    expect(deployAutomergeWorkflow).not.toContain('ref: ${{ github.event.pull_request.head.sha }}')
  })

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

  test('allowlists every Torghut maintenance manifest promoted by torghut-release', () => {
    const promotedMaintenanceManifests = [
      'argocd/applications/torghut/generated-resource-retention-cronjob.yaml',
      'argocd/applications/torghut/broker-economic-ledger-reconciliation-cronjob.yaml',
      'argocd/applications/torghut/tigerbeetle-smoke-job.yaml',
    ]

    for (const manifestPath of promotedMaintenanceManifests) {
      expect(releaseWorkflow).toContain(manifestPath)
      expect(countOccurrences(deployAutomergeWorkflow, `'${manifestPath}'`)).toBeGreaterThanOrEqual(2)
    }
  })

  test('carries the scheduler image through release and automatic deploy merge allowlists', () => {
    const schedulerManifest = 'argocd/applications/torghut/scheduler-deployment.yaml'

    expect(countOccurrences(releaseWorkflow, schedulerManifest)).toBe(3)
    expect(countOccurrences(deployAutomergeWorkflow, `'${schedulerManifest}'`)).toBe(2)
  })

  test('carries the options archive image through release and automatic deploy merge allowlists', () => {
    const archiveManifest = 'argocd/applications/torghut-options/archive/deployment.yaml'

    expect(countOccurrences(releaseWorkflow, archiveManifest)).toBe(3)
    expect(countOccurrences(deployAutomergeWorkflow, `'${archiveManifest}'`)).toBe(2)
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

  test('verifies the promoted digest contract without rediscovering source build runs', () => {
    expect(deployAutomergeWorkflow).toContain('name: Verify source image digest contract')
    expect(deployAutomergeWorkflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'codex/torghut-release-')",
    )
    expect(deployAutomergeWorkflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'codex/torghut-ta-release-')",
    )
    expect(deployAutomergeWorkflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'codex/torghut-ws-release-')",
    )
    expect(deployAutomergeWorkflow).toContain("expected_image='registry.ide-newton.ts.net/lab/torghut'")
    expect(deployAutomergeWorkflow).toContain("expected_image='registry.ide-newton.ts.net/lab/torghut-ta'")
    expect(deployAutomergeWorkflow).toContain("expected_image='registry.ide-newton.ts.net/lab/torghut-ws'")
    expect(deployAutomergeWorkflow).toContain("source_env_name='TORGHUT_COMMIT'")
    expect(deployAutomergeWorkflow).toContain("source_env_name='TORGHUT_TA_COMMIT'")
    expect(deployAutomergeWorkflow).toContain("source_env_name='TORGHUT_WS_COMMIT'")
    expect(deployAutomergeWorkflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
    expect(deployAutomergeWorkflow).toContain(
      'nix run .#assert-oci-platforms -- "${image_ref}" linux/amd64 linux/arm64',
    )
    expect(deployAutomergeWorkflow).not.toContain('docker buildx')
    expect(deployAutomergeWorkflow).toContain('release manifest pins a multi-arch image digest')
    expect(deployAutomergeWorkflow).not.toContain('gh run list')
    expect(deployAutomergeWorkflow).not.toContain('gh run view')
    expect(deployAutomergeWorkflow).not.toContain('name: Wait for source commit Torghut CI')
    expect(deployAutomergeWorkflow).not.toContain('--workflow torghut-ci.yml')
  })

  test('bounds release-check polling so generated release PRs fail fast', () => {
    expect(deployAutomergeWorkflow).toContain('deadline=$((SECONDS + 600))')
    expect(deployAutomergeWorkflow).toContain('sleep 10')
    expect(deployAutomergeWorkflow).not.toContain('deadline=$((SECONDS + 2700))')
  })

  test('waits for the consolidated pull-request validation checks', () => {
    expect(deployAutomergeWorkflow).toContain("'CI|PR validation (argo-lint)'")
    expect(deployAutomergeWorkflow).toContain("'CI|PR validation (kubeconform)'")
    expect(deployAutomergeWorkflow).not.toContain("'argo-lint|lint'")
    expect(deployAutomergeWorkflow).not.toContain("'kubeconform|validate'")
  })

  test('squash-merges generated release PRs after explicit gates instead of enabling brittle automerge', () => {
    expect(deployAutomergeWorkflow).toContain('name: Squash merge release PR')
    expect(deployAutomergeWorkflow).toContain('--json state,mergeStateStatus,isDraft')
    expect(deployAutomergeWorkflow).toContain('CLEAN | UNSTABLE)')
    expect(deployAutomergeWorkflow).toContain('gh pr merge "${PR_NUMBER}" -R "${GH_REPO}" --squash')
    expect(deployAutomergeWorkflow).not.toContain('gh pr merge "${PR_NUMBER}" -R "${GH_REPO}" --auto --squash')
  })

  test('allowlists hyperliquid feed image promotion PRs with a feed digest gate', () => {
    const manifestPath = 'argocd/applications/torghut-hyperliquid-feed/deployment.yaml'

    expect(hyperliquidFeedReleaseWorkflow).toContain(manifestPath)
    expect(hyperliquidFeedReleaseWorkflow).not.toContain('writer-deployment.yaml')
    expect(hyperliquidFeedReleaseWorkflow).not.toContain('parity-cronjob.yaml')
    expect(hyperliquidFeedReleaseWorkflow).toContain(
      'codex/torghut-hyperliquid-feed-release-${{ steps.meta.outputs.tag }}',
    )
    expect(countOccurrences(deployAutomergeWorkflow, `'${manifestPath}'`)).toBeGreaterThanOrEqual(2)
    expect(deployAutomergeWorkflow).not.toContain('writer-deployment.yaml')
    expect(deployAutomergeWorkflow).not.toContain('parity-cronjob.yaml')
    expect(deployAutomergeWorkflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'codex/torghut-hyperliquid-feed-release-')",
    )
    expect(deployAutomergeWorkflow).toContain("steps.gates.outputs.release_lane == 'hyperliquid-feed'")
    expect(deployAutomergeWorkflow).toContain('name: Verify source Hyperliquid feed image digest contract')
    expect(deployAutomergeWorkflow).toContain('Hyperliquid feed release manifest pins a multi-arch image digest')
    expect(deployAutomergeWorkflow).toContain('TORGHUT_HYPERLIQUID_FEED_COMMIT')
  })
})
