import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildRunSpecContext,
  buildRunSpec,
  getMountedConfigMapNames,
  makeName,
  normalizeLabelValue,
  resolveRunnerServiceAccount,
  submitJobRun,
  verifyJobConfigMaps,
} from '~/server/agents-controller/job-runtime'

const readJobPodSpec = (job: Record<string, unknown> | undefined) => {
  const jobSpec = (job?.spec as Record<string, unknown> | undefined) ?? {}
  const template = (jobSpec.template as Record<string, unknown> | undefined) ?? {}
  return (template.spec as Record<string, unknown> | undefined) ?? {}
}

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

  it('resolves runner service account from runtime, provider, then env default', () => {
    process.env.AGENTS_AGENT_RUNNER_SERVICE_ACCOUNT = 'runner-default'
    expect(resolveRunnerServiceAccount({ serviceAccount: 'runtime-sa' })).toBe('runtime-sa')
    expect(resolveRunnerServiceAccount({ serviceAccountName: 'runtime-sa-name' })).toBe('runtime-sa-name')
    expect(resolveRunnerServiceAccount({}, { spec: { workload: { serviceAccountName: 'provider-sa' } } })).toBe(
      'provider-sa',
    )
    expect(
      resolveRunnerServiceAccount(
        { serviceAccountName: 'runtime-sa-name' },
        { spec: { workload: { serviceAccountName: 'provider-sa' } } },
      ),
    ).toBe('runtime-sa-name')
    expect(resolveRunnerServiceAccount({})).toBe('runner-default')
  })

  it('mounts a rotating provider identity token without the default Kubernetes token', async () => {
    const applied: Record<string, unknown>[] = []
    const kube = {
      get: vi.fn(async () => null),
      apply: vi.fn(async (resource: Record<string, unknown>) => {
        applied.push(resource)
        return resource
      }),
    }

    await submitJobRun(
      kube as never,
      { metadata: { name: 'linear-run', uid: 'run-uid-1', namespace: 'agents' }, spec: {} },
      { metadata: { name: 'codex-linear-agent' }, spec: {} },
      {
        metadata: { name: 'codex-linear' },
        spec: {
          workload: {
            serviceAccountName: 'codex-linear-runner',
            serviceAccountToken: {
              audience: 'agents.proompteng.ai/linear-mcp',
              expirationSeconds: 600,
              mountPath: '/var/run/secrets/agents-linear-mcp',
            },
          },
        },
      },
      { source: { provider: 'linear', externalId: 'PROOMPT-123' }, summary: 'Run summary' },
      null,
      'agents',
      'registry.example/agents-codex-runner:tag',
      'job',
    )

    const job = applied.find((resource) => resource.kind === 'Job')
    const podSpec = readJobPodSpec(job)
    const container = (podSpec.containers as Record<string, unknown>[])[0] ?? {}
    const env = (container.env as Record<string, unknown>[]) ?? []
    const volumes = (podSpec.volumes as Record<string, unknown>[]) ?? []
    const mounts = (container.volumeMounts as Record<string, unknown>[]) ?? []

    expect(podSpec.serviceAccountName).toBe('codex-linear-runner')
    expect(podSpec.automountServiceAccountToken).toBe(false)
    expect(env).toContainEqual({
      name: 'AGENTS_MCP_IDENTITY_TOKEN_PATH',
      value: '/var/run/secrets/agents-linear-mcp/token',
    })
    expect(volumes).toContainEqual(
      expect.objectContaining({
        projected: {
          defaultMode: 420,
          sources: [
            {
              serviceAccountToken: {
                audience: 'agents.proompteng.ai/linear-mcp',
                expirationSeconds: 600,
                path: 'token',
              },
            },
          ],
        },
      }),
    )
    expect(mounts).toContainEqual(
      expect.objectContaining({
        mountPath: '/var/run/secrets/agents-linear-mcp',
        readOnly: true,
      }),
    )
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

  it('emits provider output artifact declarations into codex app-server runner specs', async () => {
    const applied: Record<string, unknown>[] = []
    const kube = {
      get: vi.fn(async () => null),
      apply: vi.fn(async (resource: Record<string, unknown>) => {
        applied.push(resource)
        return resource
      }),
    }

    await submitJobRun(
      kube as never,
      { metadata: { name: 'run-1', uid: 'run-uid-1', namespace: 'agents' }, spec: {} },
      { metadata: { name: 'agent-a' }, spec: {} },
      {
        metadata: { name: 'codex' },
        spec: {
          adapter: {
            type: 'codex-app-server',
            codex: {
              secretEnv: [
                {
                  name: 'CODEX_GRAF_BEARER_TOKEN',
                  secretName: 'graf-api',
                  key: 'bearer-tokens',
                  optional: true,
                },
              ],
            },
          },
          outputArtifacts: [
            {
              name: 'codex-artifact',
              path: '/workspace/{{ inputs.stage }}/artifact.json',
              key: 'codex-research/{{ agentRun.name }}/codex-artifact.json',
            },
          ],
        },
      },
      { metadata: { name: 'impl-a' }, source: { provider: 'github' }, summary: 'Run summary' },
      null,
      'agents',
      'registry.example/agents-codex-runner:tag',
      'job',
      { parameters: { stage: 'research' } },
    )

    const specConfigMap = applied.find(
      (resource) =>
        resource.kind === 'ConfigMap' &&
        typeof (resource.data as Record<string, unknown> | undefined)?.['agent-runner.json'] === 'string',
    )
    const data = specConfigMap?.data as Record<string, string> | undefined
    const runSpec = JSON.parse(data?.['run.json'] ?? '{}') as Record<string, unknown>
    const runnerSpec = JSON.parse(data?.['agent-runner.json'] ?? '{}') as Record<string, unknown>
    const job = applied.find((resource) => resource.kind === 'Job')
    const env = (
      ((job?.spec as Record<string, unknown>)?.template as Record<string, unknown>)?.spec as Record<string, unknown>
    )?.containers
    const agentRunnerEnv = (((env as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown>)?.env ??
      []) as Record<string, unknown>[]
    const agentRunnerContainer = (env as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown>

    expect(runnerSpec).toMatchObject({
      schemaVersion: 'agents.proompteng.ai/runner/v1',
      provider: 'codex',
      inputs: { stage: 'research' },
      adapter: {
        type: 'codex-app-server',
        codex: {
          model: 'gpt-5.6-sol',
          effort: 'high',
          sandbox: 'danger-full-access',
          approval: 'never',
          threadConfig: { mcp_servers: {}, web_search: 'live' },
          prompt: 'Run summary',
        },
      },
      providerSpec: {
        outputArtifacts: [
          {
            name: 'codex-artifact',
            path: '/workspace/{{ inputs.stage }}/artifact.json',
            key: 'codex-research/{{ agentRun.name }}/codex-artifact.json',
          },
        ],
      },
    })
    expect(runSpec.artifacts).toEqual([
      {
        name: 'codex-artifact',
        path: '/workspace/research/artifact.json',
        key: 'codex-research/run-1/codex-artifact.json',
      },
    ])
    expect(agentRunnerEnv).toContainEqual({
      name: 'CODEX_GRAF_BEARER_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: 'graf-api',
          key: 'bearer-tokens',
          optional: true,
        },
      },
    })
    expect(agentRunnerContainer.terminationMessagePath).toBe('/workspace/.agent/status.json')
    expect(agentRunnerContainer.terminationMessagePolicy).toBe('File')
  })

  it('preserves the image-baked Codex home when no auth secret is configured', async () => {
    const previousName = process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
    const previousKey = process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY
    const previousMountPath = process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH
    delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
    delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY
    delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH

    try {
      const applied: Record<string, unknown>[] = []
      const kube = {
        get: vi.fn(async () => null),
        apply: vi.fn(async (resource: Record<string, unknown>) => {
          applied.push(resource)
          return resource
        }),
      }

      await submitJobRun(
        kube as never,
        { metadata: { name: 'run-1', uid: 'run-uid-1', namespace: 'agents' }, spec: {} },
        { metadata: { name: 'agent-a' }, spec: {} },
        {
          metadata: { name: 'codex' },
          spec: {
            binary: '/usr/local/bin/agent-runner',
            adapter: { type: 'codex-app-server', codex: { prompt: 'demo prompt' } },
          },
        },
        { metadata: { name: 'impl-a' }, source: { provider: 'github' }, summary: 'Run summary' },
        null,
        'agents',
        'registry.example/agents-codex-runner:tag',
        'job',
      )

      const job = applied.find((resource) => resource.kind === 'Job')
      const podSpec = (job?.spec as Record<string, unknown> | undefined)?.template as
        | Record<string, unknown>
        | undefined
      const podSpecSpec = (podSpec?.spec as Record<string, unknown> | undefined) ?? {}
      const containers = (podSpecSpec.containers as Record<string, unknown>[] | undefined) ?? []
      const container = containers[0] ?? {}
      const env = (container.env as Record<string, unknown>[] | undefined) ?? []
      const volumes = (podSpecSpec.volumes as Record<string, unknown>[] | undefined) ?? []
      const volumeMounts = (container.volumeMounts as Record<string, unknown>[] | undefined) ?? []

      expect(env).toContainEqual({ name: 'CODEX_HOME', value: '/root/.codex' })
      expect(env.find((entry) => entry.name === 'CODEX_AUTH')).toBeUndefined()
      expect(volumes.find((volume) => volume.name === 'run-1-codex-home')).toBeUndefined()
      expect(volumeMounts.find((mount) => mount.mountPath === '/root/.codex')).toBeUndefined()
    } finally {
      if (previousName === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME = previousName
      }
      if (previousKey === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY = previousKey
      }
      if (previousMountPath === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH = previousMountPath
      }
    }
  })

  it('does not add a duplicate default Codex home mount when workload already mounts it', async () => {
    const previousName = process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
    const previousKey = process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY
    const previousMountPath = process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH
    delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
    delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY
    delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH

    try {
      const applied: Record<string, unknown>[] = []
      const kube = {
        get: vi.fn(async () => null),
        apply: vi.fn(async (resource: Record<string, unknown>) => {
          applied.push(resource)
          return resource
        }),
      }

      await submitJobRun(
        kube as never,
        {
          metadata: { name: 'run-1', uid: 'run-uid-1', namespace: 'agents' },
          spec: {
            workload: {
              volumes: [
                {
                  type: 'emptyDir',
                  name: 'custom-codex-home',
                  mountPath: '/root/.codex',
                },
              ],
            },
          },
        },
        { metadata: { name: 'agent-a' }, spec: {} },
        {
          metadata: { name: 'codex' },
          spec: {
            binary: '/usr/local/bin/agent-runner',
            adapter: { type: 'codex-app-server', codex: { prompt: 'demo prompt' } },
          },
        },
        { metadata: { name: 'impl-a' }, source: { provider: 'github' }, summary: 'Run summary' },
        null,
        'agents',
        'registry.example/agents-codex-runner:tag',
        'job',
      )

      const job = applied.find((resource) => resource.kind === 'Job')
      const podSpec = (job?.spec as Record<string, unknown> | undefined)?.template as
        | Record<string, unknown>
        | undefined
      const podSpecSpec = (podSpec?.spec as Record<string, unknown> | undefined) ?? {}
      const containers = (podSpecSpec.containers as Record<string, unknown>[] | undefined) ?? []
      const container = containers[0] ?? {}
      const env = (container.env as Record<string, unknown>[] | undefined) ?? []
      const volumeMounts = (container.volumeMounts as Record<string, unknown>[] | undefined) ?? []

      expect(env).toContainEqual({ name: 'CODEX_HOME', value: '/root/.codex' })
      expect(volumeMounts.filter((mount) => mount.mountPath === '/root/.codex')).toEqual([
        { name: 'custom-codex-home', mountPath: '/root/.codex', readOnly: false },
      ])
    } finally {
      if (previousName === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME = previousName
      }
      if (previousKey === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY = previousKey
      }
      if (previousMountPath === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH = previousMountPath
      }
    }
  })

  it('returns an existing deterministic job for the same AgentRun', async () => {
    const applied: Record<string, unknown>[] = []
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
      apply: vi.fn(async (resource: Record<string, unknown>) => {
        applied.push(resource)
        return resource
      }),
    }

    const runtimeRef = await submitJobRun(
      kube as never,
      { metadata: { name: 'run-1', uid: 'run-uid-1', namespace: 'agents' }, spec: {} },
      { metadata: { name: 'agent-a' }, spec: {} },
      {
        metadata: { name: 'provider-a' },
        spec: {
          inputFiles: [{ path: '/workspace/input.txt', content: 'restored input' }],
        },
      },
      { metadata: { name: 'impl-a' }, source: { provider: 'github' }, summary: 'Run summary' },
      null,
      'agents',
      'registry.example/agents-runner:tag',
      'workflow',
      { nameSuffix: 'step-1-attempt-1' },
    )

    expect(runtimeRef).toEqual({
      type: 'workflow',
      name: 'run-1-step-1-attempt-1',
      namespace: 'agents',
      uid: 'job-uid-1',
    })
    expect(applied.filter((resource) => resource.kind === 'ConfigMap')).toHaveLength(2)
    expect(
      applied.find(
        (resource) =>
          resource.kind === 'ConfigMap' &&
          Boolean((resource.data as Record<string, unknown> | undefined)?.['agent-runner.json']),
      ),
    ).toBeTruthy()
    expect(applied).not.toContainEqual(expect.objectContaining({ kind: 'Job' }))
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
      'registry.example/agents-runner:tag',
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

  it('detects missing ConfigMaps mounted by an existing job', async () => {
    const job = {
      spec: {
        template: {
          spec: {
            volumes: [
              { name: 'run-spec', configMap: { name: 'run-1-spec' } },
              { name: 'run-inputs', configMap: { name: 'run-1-inputs' } },
              { name: 'workspace', emptyDir: {} },
            ],
          },
        },
      },
    }
    const kube = {
      get: vi.fn(async (_resource: string, name: string) => (name === 'run-1-spec' ? { metadata: { name } } : null)),
    }

    expect(getMountedConfigMapNames(job)).toEqual(['run-1-inputs', 'run-1-spec'])
    await expect(verifyJobConfigMaps(kube as never, job, 'agents')).resolves.toEqual({
      ok: false,
      names: ['run-1-inputs', 'run-1-spec'],
      missing: ['run-1-inputs'],
    })
  })
})
