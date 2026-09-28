import { describe, expect, it } from 'vitest'

import { extractAgentRunDetail, formatRelativeAge, isAgentRunDetailKind } from './agentrun-detail'

describe('AgentRun detail model', () => {
  it('recognizes AgentRun detail route aliases', () => {
    expect(isAgentRunDetailKind('agent-run')).toBe(true)
    expect(isAgentRunDetailKind('AgentRun')).toBe(true)
    expect(isAgentRunDetailKind('agentruns')).toBe(true)
    expect(isAgentRunDetailKind('agent')).toBe(false)
  })

  it('extracts high-signal status, refs, attempts, resources, and artifacts', () => {
    const detail = extractAgentRunDetail(
      {
        kind: 'AgentRun',
        metadata: {
          name: 'run-1',
          namespace: 'agents',
          uid: 'uid-1',
          generation: 3,
          creationTimestamp: '2026-05-25T10:00:00.000Z',
        },
        spec: {
          agentRef: { name: 'codex-agent' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'workflow' },
          vcsPolicy: { mode: 'read-write' },
        },
        status: {
          phase: 'Failed',
          reason: 'StepFailed',
          message: 'tests failed',
          startedAt: '2026-05-25T10:01:00.000Z',
          finishedAt: '2026-05-25T10:03:05.000Z',
          runtimeRef: { type: 'workflow', name: 'run-1-step-1', namespace: 'agents' },
          vcs: {
            provider: 'github',
            repository: 'proompteng/lab',
            baseBranch: 'main',
            headBranch: 'codex/example',
            mode: 'read-write',
          },
          conditions: [
            {
              type: 'Failed',
              status: 'True',
              reason: 'StepFailed',
              message: 'step build failed',
              lastTransitionTime: '2026-05-25T10:03:05.000Z',
            },
          ],
          workflow: {
            steps: [
              {
                name: 'build',
                phase: 'Failed',
                attempt: 2,
                startedAt: '2026-05-25T10:02:00.000Z',
                finishedAt: '2026-05-25T10:03:05.000Z',
                jobRef: { name: 'run-1-build-attempt-2', namespace: 'agents' },
              },
            ],
          },
          artifacts: [{ name: 'summary', key: 'runs/run-1/summary.md', url: 'https://example.test/summary.md' }],
        },
      },
      Date.parse('2026-05-25T11:00:00.000Z'),
    )

    expect(detail).toMatchObject({
      name: 'run-1',
      namespace: 'agents',
      phase: 'Failed',
      phaseTone: 'danger',
      statusSummary: 'tests failed',
      agentName: 'codex-agent',
      implementationSpecName: 'impl-1',
      runtimeType: 'workflow',
      age: '1h ago',
      duration: '2m 5s',
      attemptSummary: 'Max attempt 2',
      artifactSummary: '1 artifact, 1 with location',
    })
    expect(detail.resourceLinks.map((link) => `${link.kind}/${link.name}`)).toEqual([
      'Workflow/run-1-step-1',
      'Job/run-1-build-attempt-2',
    ])
    expect(detail.conditions[0]?.message).toBe('step build failed')
    expect(detail.vcs.repository).toBe('proompteng/lab')
  })

  it('handles sparse pending AgentRuns without inventing events or resources', () => {
    const detail = extractAgentRunDetail({
      metadata: { name: 'run-2' },
      spec: { runtime: { type: 'job' } },
      status: {},
    })

    expect(detail.namespace).toBe('agents')
    expect(detail.phase).toBe('Unknown')
    expect(detail.statusSummary).toBe('The controller has not reported a phase yet.')
    expect(detail.resourceLinks).toEqual([])
    expect(detail.artifacts).toEqual([])
    expect(detail.artifactSummary).toBe('No artifacts reported')
  })

  it('formats relative age defensively', () => {
    const now = Date.parse('2026-05-25T11:00:00.000Z')
    expect(formatRelativeAge('2026-05-25T10:59:45.000Z', now)).toBe('just now')
    expect(formatRelativeAge('2026-05-25T10:30:00.000Z', now)).toBe('30m ago')
    expect(formatRelativeAge('2026-05-24T09:00:00.000Z', now)).toBe('26h ago')
    expect(formatRelativeAge('not-a-date', now)).toBe('-')
  })
})
