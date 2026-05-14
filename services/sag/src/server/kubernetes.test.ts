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
