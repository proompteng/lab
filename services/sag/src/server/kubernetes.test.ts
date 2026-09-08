import { describe, expect, test } from 'vitest'
import { buildAgentRunManifest } from './kubernetes'

describe('SAG AgentRun manifests', () => {
  test('include issue metadata required by the in-cluster runner', () => {
    const manifest = buildAgentRunManifest({
      name: 'sag-test',
      namespace: 'agents',
      agent: 'codex-agent',
      task: 'Inspect repository health without changing files.',
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/sag-test',
      issueNumber: '0',
      issueTitle: 'SAG AgentRun',
      issueUrl: 'https://sag.proompteng.ai',
    })

    expect(manifest.spec.parameters).toMatchObject({
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/sag-test',
      issueNumber: '0',
      issueTitle: 'SAG AgentRun',
      issueUrl: 'https://sag.proompteng.ai',
      stage: 'implementation',
    })
    expect(manifest.spec.vcsRef).toEqual({ name: 'github' })
    expect(manifest.spec.vcsPolicy).toEqual({
      required: true,
      mode: 'read-write',
    })
    expect(manifest.spec.secrets).toEqual(['github-token', 'codex-auth'])
    expect(manifest.spec.workflow.steps[0]?.parameters).toMatchObject({
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/sag-test',
      issueNumber: '0',
      issueTitle: 'SAG AgentRun',
      issueUrl: 'https://sag.proompteng.ai',
      stage: 'implementation',
    })
  })
})
