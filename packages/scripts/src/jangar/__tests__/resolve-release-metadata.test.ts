import { describe, expect, it } from 'bun:test'

import { readReleaseContract } from '../release-contract'
import { __private } from '../resolve-release-metadata'

const f22a8cbc = 'f22a8cbc91f8462d5e375e7684a38b03af271dde'
const ddd07d2f = 'ddd07d2f5a8eb0b7d96f297d3a892f48bdef1d1b'
const bf889391 = 'bf889391d4f55a10d6d7ca702289925cc2c5c869'

const dddToBfDocsOnlyFiles = ['docs/agents/README.md', 'docs/agents/designs/jangar-swarm-intelligence-owner-serving.md']

const f22ToDddJangarBuildTriggerFiles = [
  'argocd/applications/agents/values.yaml',
  'argocd/applications/jangar/deployment.yaml',
  'argocd/applications/jangar/jangar-worker-deployment.yaml',
  'argocd/applications/jangar/kustomization.yaml',
  'docs/agents/jangar-controller-design.md',
  'services/jangar/scripts/__tests__/agent-runner.test.ts',
  'services/jangar/scripts/agent-runner.ts',
  'services/jangar/src/server/__tests__/agents-controller.test.ts',
  'services/jangar/src/server/agents-controller/job-runtime.ts',
  'services/torghut/README.md',
  'services/torghut/app/trading/alpha/__init__.py',
  'services/torghut/app/trading/alpha/lane.py',
  'services/torghut/app/trading/autonomy/lane.py',
  'services/torghut/scripts/run_alpha_discovery_lane.py',
  'services/torghut/tests/test_alpha_lane.py',
  'services/torghut/tests/test_autonomous_lane.py',
]

describe('resolve-release-metadata', () => {
  it('prefers control-plane metadata from the release contract when present', () => {
    const resolved = __private.resolveControlPlaneContractFields(
      readReleaseContract('packages/scripts/src/jangar/__fixtures__/release-contract-with-control-plane.json'),
      'registry.ide-newton.ts.net/lab/jangar-control-plane',
    )

    expect(resolved).toEqual({
      controlPlaneImage: 'registry.ide-newton.ts.net/lab/jangar-control-plane',
      contractControlPlaneDigest: 'sha256:6e621beae7d0c07f1d3ae3618435b762f954e1b1410e46ea7dac56db8f5ced96',
    })
  })

  it('falls back to the configured control-plane repository for older contracts', () => {
    const resolved = __private.resolveControlPlaneContractFields(
      readReleaseContract('packages/scripts/src/jangar/__fixtures__/release-contract-without-control-plane.json'),
      'registry.ide-newton.ts.net/lab/jangar-control-plane',
    )

    expect(resolved).toEqual({
      controlPlaneImage: 'registry.ide-newton.ts.net/lab/jangar-control-plane',
      contractControlPlaneDigest: '',
    })
  })

  it('regression fixture: allows promotion when newer main files are docs-only', () => {
    const decision = __private.evaluateWorkflowRunStaleness({
      sourceSha: ddd07d2f,
      mainHead: bf889391,
      isAncestor: true,
      changedMainFiles: ['docs/agents/README.md', 'docs/agents/designs/jangar-swarm-intelligence-owner-serving.md'],
    })

    expect(decision).toEqual({
      promote: true,
      reason: 'newer-main-non-jangar-only',
    })
  })

  it('regression from git history fixture: keeps ddd07d2f promotable after docs-only main advance', () => {
    const decision = __private.evaluateWorkflowRunStaleness({
      sourceSha: ddd07d2f,
      mainHead: bf889391,
      isAncestor: true,
      changedMainFiles: dddToBfDocsOnlyFiles,
    })

    expect(decision).toEqual({
      promote: true,
      reason: 'newer-main-non-jangar-only',
    })
    expect(dddToBfDocsOnlyFiles.some((filePath) => filePath.startsWith('docs/agents/'))).toBe(true)
    expect(dddToBfDocsOnlyFiles.some((filePath) => __private.isBuildTriggerPath(filePath))).toBe(false)
  })

  it('regression from git history fixture: blocks f22a8cbc promotion when newer main has jangar changes', () => {
    const decision = __private.evaluateWorkflowRunStaleness({
      sourceSha: f22a8cbc,
      mainHead: ddd07d2f,
      isAncestor: true,
      changedMainFiles: f22ToDddJangarBuildTriggerFiles,
    })

    expect(decision).toEqual({
      promote: false,
      reason: 'newer-main-has-jangar-changes',
    })
    expect(f22ToDddJangarBuildTriggerFiles.some((filePath) => __private.isBuildTriggerPath(filePath))).toBe(true)
  })
})
