import { describe, expect, it } from 'bun:test'

import { __private } from '../resolve-release-metadata'

const f22a8cbc = 'f22a8cbc91f8462d5e375e7684a38b03af271dde'
const ddd07d2f = 'ddd07d2f5a8eb0b7d96f297d3a892f48bdef1d1b'
const bf889391 = 'bf889391d4f55a10d6d7ca702289925cc2c5c869'

const dddToBfDocsOnlyFiles = ['docs/agents/README.md', 'docs/agents/designs/jangar-swarm-intelligence-owner-serving.md']

const f22ToDddJangarBuildTriggerFiles = [
  'argocd/applications/agents/values.yaml',
  'argocd/applications/jangar/deployment.yaml',
  'argocd/applications/jangar/kustomization.yaml',
  'docs/agents/jangar-controller-design.md',
  'services/jangar/src/server/__tests__/codex-judge.test.ts',
  'services/jangar/src/server/torghut-market-context-dispatch.ts',
  'services/jangar/src/server/whitepaper-finalize-consumer.ts',
  'services/torghut/README.md',
  'services/torghut/app/trading/alpha/__init__.py',
  'services/torghut/app/trading/alpha/lane.py',
  'services/torghut/app/trading/autonomy/lane.py',
  'services/torghut/scripts/run_alpha_discovery_lane.py',
  'services/torghut/tests/test_alpha_lane.py',
  'services/torghut/tests/test_autonomous_lane.py',
]

describe('resolve-release-metadata', () => {
  it('emits only Jangar runtime image metadata', () => {
    expect(
      __private.toGitHubOutputLines({
        mainHead: bf889391,
        sourceSha: ddd07d2f,
        tag: 'ddd07d2f',
        contractDigest: 'sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe',
        image: 'registry.ide-newton.ts.net/lab/jangar',
        promote: true,
        reason: 'head-current',
      }),
    ).toEqual([
      `main_head=${bf889391}`,
      `source_sha=${ddd07d2f}`,
      'tag=ddd07d2f',
      'contract_digest=sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe',
      'image=registry.ide-newton.ts.net/lab/jangar',
      'promote=true',
      'promotion_reason=head-current',
    ])
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

  it('blocks Jangar promotion when newer main has Codex package image inputs', () => {
    const decision = __private.evaluateWorkflowRunStaleness({
      sourceSha: ddd07d2f,
      mainHead: bf889391,
      isAncestor: true,
      changedMainFiles: [
        'packages/codex/src/app-server-client.ts',
        'skills/agent-harness/SKILL.md',
        'argocd/applications/agents/values.yaml',
      ],
    })

    expect(decision).toEqual({
      promote: false,
      reason: 'newer-main-has-jangar-changes',
    })
  })

  it('does not treat root package script changes as Jangar build changes', () => {
    const decision = __private.evaluateWorkflowRunStaleness({
      sourceSha: ddd07d2f,
      mainHead: bf889391,
      isAncestor: true,
      changedMainFiles: ['package.json'],
    })

    expect(decision).toEqual({
      promote: true,
      reason: 'newer-main-non-jangar-only',
    })
    expect(__private.isBuildTriggerPath('package.json')).toBe(false)
  })

  it('does not treat workflow-only changes as Jangar build changes', () => {
    const decision = __private.evaluateWorkflowRunStaleness({
      sourceSha: ddd07d2f,
      mainHead: bf889391,
      isAncestor: true,
      changedMainFiles: ['.github/workflows/jangar-build-push.yaml'],
    })

    expect(decision).toEqual({
      promote: true,
      reason: 'newer-main-non-jangar-only',
    })
    expect(__private.isBuildTriggerPath('.github/workflows/jangar-build-push.yaml')).toBe(false)
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
