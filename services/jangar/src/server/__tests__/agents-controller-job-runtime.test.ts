import { afterEach, describe, expect, it } from 'vitest'

import {
  buildRunSpec,
  makeName,
  normalizeLabelValue,
  resolveRunnerServiceAccount,
} from '~/server/agents-controller/job-runtime'

describe('agents controller job-runtime module', () => {
  afterEach(() => {
    delete process.env.JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT
  })

  it('creates DNS-safe names and appends stable hash when needed', () => {
    const short = makeName('Run_One', 'job')
    expect(short).toBe('run-one-job')

    const longBase = 'x'.repeat(80)
    const long = makeName(longBase, 'workflow')
    expect(long.length).toBeLessThanOrEqual(63)
    expect(long).toMatch(/^x+-[a-f0-9]{8}$/)
  })

  it('normalizes Kubernetes label values', () => {
    expect(normalizeLabelValue('Team/Backend')).toBe('team-backend')
    expect(normalizeLabelValue('___')).toBe('unknown')
  })

  it('resolves runner service account from runtime config or env default', () => {
    process.env.JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT = 'runner-default'
    expect(resolveRunnerServiceAccount({ serviceAccount: 'runtime-sa' })).toBe('runtime-sa')
    expect(resolveRunnerServiceAccount({})).toBe('runner-default')
  })

  it('builds run spec with rendered event payload and optional vcs/system prompt', () => {
    const runSpec = buildRunSpec(
      { metadata: { name: 'run-1', uid: 'uid-1', namespace: 'agents' }, spec: {} },
      { metadata: { name: 'agent-a' }, spec: {} },
      { source: { provider: 'github' }, summary: 'Fix issue' },
      { repository: 'owner/repo', issueNumber: '42' },
      null,
      [{ name: 'artifact.log' }],
      'provider-a',
      { repository: 'owner/repo' },
      'system prompt',
    )

    expect(runSpec.provider).toBe('provider-a')
    expect(runSpec.agentRun).toEqual({ name: 'run-1', uid: 'uid-1', namespace: 'agents' })
    expect(runSpec.parameters).toEqual({ repository: 'owner/repo', issueNumber: '42' })
    expect(runSpec.artifacts).toEqual([{ name: 'artifact.log' }])
    expect(runSpec.vcs).toEqual({ repository: 'owner/repo' })
    expect(runSpec.systemPrompt).toBe('system prompt')
  })
})
