import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildRunSpecContext,
  buildRunSpec,
  makeName,
  normalizeLabelValue,
  resolveRunnerServiceAccount,
  submitJobRun,
} from '~/server/agents-controller/job-runtime'

describe('agents controller job-runtime module', () => {
  afterEach(() => {
    delete process.env.AGENTS_AGENT_RUNNER_SERVICE_ACCOUNT
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

  it('resolves runner service account from runtime config aliases or env default', () => {
    process.env.AGENTS_AGENT_RUNNER_SERVICE_ACCOUNT = 'runner-default'
    expect(resolveRunnerServiceAccount({ serviceAccount: 'runtime-sa' })).toBe('runtime-sa')
    expect(resolveRunnerServiceAccount({ serviceAccountName: 'runtime-sa-name' })).toBe('runtime-sa-name')
    expect(resolveRunnerServiceAccount({})).toBe('runner-default')
  })

  it('builds run spec with rendered event payload and optional vcs/system prompt', () => {
    const runSpec = buildRunSpec(
      {
        metadata: { name: 'run-1', uid: 'uid-1', namespace: 'agents' },
        spec: { goal: { objective: 'Complete the rollout', tokenBudget: 5000 } },
      },
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
    expect(runSpec.goal).toEqual({ objective: 'Complete the rollout', tokenBudget: 5000 })
    expect(runSpec.artifacts).toEqual([{ name: 'artifact.log' }])
    expect(runSpec.vcs).toEqual({ repository: 'owner/repo' })
    expect(runSpec.systemPrompt).toBe('system prompt')
  })

  it('exposes parameters in template context under both parameters and inputs', () => {
    const context = buildRunSpecContext(
      { metadata: { name: 'run-1', uid: 'uid-1', namespace: 'agents' }, spec: {} },
      { metadata: { name: 'agent-a' }, spec: {} },
      { source: { provider: 'github' }, summary: 'Run summary' },
      { stage: 'plan', task: 'validation' },
      { spec: { type: 'postgres' }, connection: {} },
      null,
    )

    expect(context.parameters).toEqual({ stage: 'plan', task: 'validation' })
    expect(context.inputs).toEqual({ stage: 'plan', task: 'validation' })
  })

  it('returns an existing deterministic job for the same AgentRun', async () => {
    const existingJob = {
      metadata: {
        name: 'run-1-step-1-attempt-1',
        namespace: 'agents',
        uid: 'job-uid-1',
        labels: { 'agents.proompteng.ai/agent-run': 'run-1' },
      },
    }
    const kube = {
      get: vi.fn(async (resource: string) => (resource === 'job' ? existingJob : null)),
      apply: vi.fn(),
    }

    const runtimeRef = await submitJobRun(
      kube as never,
      { metadata: { name: 'run-1', uid: 'run-uid-1', namespace: 'agents' }, spec: {} },
      { metadata: { name: 'agent-a' }, spec: {} },
      { metadata: { name: 'provider-a' }, spec: {} },
      { metadata: { name: 'impl-a' }, source: { provider: 'github' }, summary: 'Run summary' },
      null,
      'agents',
      'registry.example/jangar:tag',
      'workflow',
      { nameSuffix: 'step-1-attempt-1' },
    )

    expect(runtimeRef).toEqual({
      type: 'workflow',
      name: 'run-1-step-1-attempt-1',
      namespace: 'agents',
      uid: 'job-uid-1',
    })
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('adopts an existing deterministic job after a stale apply replay hits immutable fields', async () => {
    const existingJob = {
      metadata: {
        name: 'run-1-step-1-attempt-1',
        namespace: 'agents',
        uid: 'job-uid-1',
        labels: { 'agents.proompteng.ai/agent-run': 'run-1' },
      },
    }
    let jobLookupCount = 0
    const kube = {
      get: vi.fn(async (resource: string) => {
        if (resource !== 'job') return null
        jobLookupCount += 1
        return jobLookupCount === 1 ? null : existingJob
      }),
      apply: vi.fn(async (resource: Record<string, unknown>) => {
        if (resource.kind === 'Job') {
          throw new Error('Job.batch "run-1-step-1-attempt-1" is invalid: spec.template: field is immutable')
        }
        return resource
      }),
    }

    const runtimeRef = await submitJobRun(
      kube as never,
      { metadata: { name: 'run-1', uid: 'run-uid-1', namespace: 'agents' }, spec: {} },
      { metadata: { name: 'agent-a' }, spec: {} },
      { metadata: { name: 'provider-a' }, spec: {} },
      { metadata: { name: 'impl-a' }, source: { provider: 'github' }, summary: 'Run summary' },
      null,
      'agents',
      'registry.example/jangar:tag',
      'workflow',
      { nameSuffix: 'step-1-attempt-1' },
    )

    expect(runtimeRef).toEqual({
      type: 'workflow',
      name: 'run-1-step-1-attempt-1',
      namespace: 'agents',
      uid: 'job-uid-1',
    })
    expect(kube.apply).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ConfigMap' }))
    expect(kube.apply).toHaveBeenCalledWith(expect.objectContaining({ kind: 'Job' }))
  })
})
