import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  let previousEnv: Record<string, string | undefined>
  const savedEnv = new Map<string, string | undefined>()
  const setEnv = (key: string, value: string | undefined) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  beforeEach(() => {
    previousEnv = {
      AGENTS_AGENT_RUNNER_SERVICE_ACCOUNT: process.env.AGENTS_AGENT_RUNNER_SERVICE_ACCOUNT,
      AGENTS_AGENT_RUNNER_IMAGE: process.env.AGENTS_AGENT_RUNNER_IMAGE,
      AGENTS_AGENT_RUNNER_RESOURCES: process.env.AGENTS_AGENT_RUNNER_RESOURCES,
      AGENTS_CONTROLLER_AUTH_SECRET_NAME: process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME,
      AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH: process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH,
    }
  })

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv.clear()
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
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
    setEnv('AGENTS_AGENT_RUNNER_SERVICE_ACCOUNT', 'runner-default')
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
      {
        metadata: { name: 'linear-run', uid: 'run-uid-1', namespace: 'agents' },
        spec: { runtime: { config: { activeDeadlineSeconds: 7200 } } },
      },
      { metadata: { name: 'codex-linear-agent' }, spec: {} },
      {
        metadata: { name: 'codex-linear' },
        spec: {
          adapter: { type: 'codex-app-server', codex: { prompt: 'demo prompt' } },
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
    expect(job).toMatchObject({
      spec: {
        activeDeadlineSeconds: 7200,
        template: { metadata: { labels: { 'agents.proompteng.ai/run-uid': 'run-uid-1' } } },
      },
    })
    const podSpec = readJobPodSpec(job)
    const container = (podSpec.containers as Record<string, unknown>[])[0] ?? {}
    const env = (container.env as Record<string, unknown>[]) ?? []
    const volumes = (podSpec.volumes as Record<string, unknown>[]) ?? []
    const mounts = (container.volumeMounts as Record<string, unknown>[]) ?? []

    expect(podSpec.serviceAccountName).toBe('codex-linear-runner')
    expect(podSpec.automountServiceAccountToken).toBe(false)
    expect(env).toContainEqual({ name: 'AGENT_RUN_UID', value: 'run-uid-1' })
    expect(
      applied.some((item) => (item.metadata as Record<string, unknown>)?.name === 'linear-run-job-telemetry'),
    ).toBe(false)
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

  it.each([
    { enabled: true, hostPath: '/var/lib/agents-workspace-cache', standard: true, repository: 'proompteng/lab' },
    { enabled: false, hostPath: undefined, standard: true, repository: 'proompteng/lab' },
    { enabled: false, hostPath: '/var/lib/..', standard: true, repository: 'proompteng/lab' },
    { enabled: false, hostPath: '/var/lib/agents-workspace-cache', standard: false, repository: 'proompteng/lab' },
    { enabled: false, hostPath: '/var/lib/agents-workspace-cache', standard: true, repository: 'org/other' },
  ])(
    'mounts the host workspace cache only for opted-in standard lab runs ($enabled, $hostPath, $standard, $repository)',
    async ({ enabled, hostPath, standard, repository }) => {
      const standardImage = 'registry.example/agents-codex-runner:standard'
      setEnv('AGENTS_AGENT_RUNNER_IMAGE', standardImage)
      setEnv('AGENTS_AGENT_RUNNER_SHARED_CACHE_HOST_PATH', hostPath)
      const kube = {
        get: vi.fn(async () => null),
        apply: vi.fn(async (resource: Record<string, unknown>) => resource),
      }
      await submitJobRun(
        kube as never,
        { metadata: { name: 'cache-run', namespace: 'agents' } },
        { metadata: { name: 'codex-agent' } },
        { metadata: { name: 'codex' }, spec: { adapter: { type: 'codex-app-server' } } },
        { summary: 'Run summary' },
        null,
        'agents',
        standard ? standardImage : 'registry.example/custom-runner:tag',
        'job',
        {
          vcs: {
            ok: true,
            skip: false,
            mode: 'read-only',
            requiredSecrets: [],
            context: { repository, cloneBaseUrl: 'https://github.com' },
          },
        },
      )

      const podSpec = readJobPodSpec(kube.apply.mock.calls.find(([resource]) => resource.kind === 'Job')?.[0])
      const volumes = podSpec.volumes as Record<string, unknown>[]
      const [container] = podSpec.containers as { volumeMounts: Record<string, unknown>[] }[]
      const name = 'cache-run-shared-workspace-cache'
      expect(volumes.filter((volume) => volume.hostPath)).toEqual(
        enabled ? [{ name, hostPath: { path: hostPath, type: 'DirectoryOrCreate' } }] : [],
      )
      expect(container.volumeMounts.filter((mount) => mount.mountPath === '/var/cache/agents-shared')).toEqual(
        enabled ? [{ name, mountPath: '/var/cache/agents-shared', readOnly: true }] : [],
      )
    },
  )

  it.each([
    { name: 'cache enabled', hostPath: '/var/lib/agents-workspace-cache', disk: true },
    { name: 'cache disabled', disk: true },
    { name: 'low disk request', storageRequest: '4Gi', disk: false },
    { name: 'low disk limit', storageLimit: '15.5Gi', disk: false },
    { name: 'no disk budget', noBudget: true, disk: false },
    { name: 'another repository', repository: 'org/other', disk: false },
  ])('keeps Lab checkout and Bun cache off tmpfs when disk is budgeted ($name)', async (testCase) => {
    const standardImage = 'registry.example/agents-codex-runner:standard'
    setEnv('AGENTS_AGENT_RUNNER_IMAGE', standardImage)
    setEnv('AGENTS_AGENT_RUNNER_SHARED_CACHE_HOST_PATH', testCase.hostPath)
    setEnv(
      'AGENTS_AGENT_RUNNER_RESOURCES',
      testCase.noBudget
        ? undefined
        : JSON.stringify({
            requests: { 'ephemeral-storage': '8Gi' },
            limits: { memory: '32Gi', 'ephemeral-storage': '16Gi' },
          }),
    )
    const kube = {
      get: vi.fn(async () => null),
      apply: vi.fn(async (resource: Record<string, unknown>) => resource),
    }
    await submitJobRun(
      kube as never,
      {
        metadata: { name: 'lab-run', namespace: 'agents' },
        spec: {
          workload: {
            resources: {
              requests: { 'ephemeral-storage': testCase.storageRequest },
              limits: { 'ephemeral-storage': testCase.storageLimit },
            },
          },
        },
      },
      { metadata: { name: 'codex-agent' } },
      { metadata: { name: 'codex' }, spec: { adapter: { type: 'codex-app-server' } } },
      { summary: 'Run summary' },
      null,
      'agents',
      standardImage,
      'job',
      {
        vcs: {
          ok: true,
          skip: false,
          mode: 'read-only',
          requiredSecrets: [],
          context: { repository: testCase.repository ?? 'proompteng/lab', cloneBaseUrl: 'https://github.com' },
        },
      },
    )

    const podSpec = readJobPodSpec(kube.apply.mock.calls.find(([resource]) => resource.kind === 'Job')?.[0])
    const volumes = podSpec.volumes as { name: string; emptyDir?: { medium?: string; sizeLimit?: string } }[]
    const [container] = podSpec.containers as { volumeMounts: { name: string; mountPath: string }[] }[]
    const scratchAt = (path: string) => {
      const mount = container.volumeMounts.find((entry) => entry.mountPath === path)
      return volumes.find((volume) => volume.name === mount?.name)?.emptyDir
    }
    const medium = testCase.disk ? {} : { medium: 'Memory' }
    expect(scratchAt('/workspace')).toEqual({ ...medium, sizeLimit: '16Gi' })
    expect(scratchAt('/opt/bun/install/cache')).toEqual({ ...medium, sizeLimit: '8Gi' })
    expect(scratchAt('/tmp')).toEqual({ medium: 'Memory', sizeLimit: '6Gi' })
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

    expect(agentRunnerEnv).toContainEqual({ name: 'AGENT_RUN_UID', value: 'run-uid-1' })
    expect(applied.some((item) => (item.metadata as Record<string, unknown>)?.name === 'run-1-job-telemetry')).toBe(
      false,
    )

    expect(runnerSpec).toMatchObject({
      schemaVersion: 'agents.proompteng.ai/runner/v1',
      provider: 'codex',
      inputs: { stage: 'research' },
      adapter: {
        type: 'codex-app-server',
        codex: {
          model: 'gpt-6.2-sol',
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

  it.each([
    {
      name: 'standard runner',
      sizeLimits: { '/workspace': '16Gi', '/tmp': '6Gi', '/opt/bun/install/cache': '8Gi', '/root/.codex': '1Gi' },
    },
    {
      name: 'standard runner with a smaller workload memory limit',
      memoryLimit: '1.5Gi',
      sizeLimits: { '/workspace': '1.5Gi', '/tmp': '1.5Gi', '/opt/bun/install/cache': '1.5Gi', '/root/.codex': '1Gi' },
    },
    {
      name: 'standard runner with a sub-GiB workload memory limit',
      memoryLimit: '500M',
      sizeLimits: { '/workspace': '500M', '/tmp': '500M', '/opt/bun/install/cache': '500M', '/root/.codex': '500M' },
    },
    {
      name: 'declared workspace and Bun install mounts',
      persistentWorkspace: true,
      sizeLimits: { '/tmp': '6Gi', '/root/.codex': '1Gi' },
    },
    { name: 'custom runner image', customImage: true, sizeLimits: {} },
  ])('bounds the generated tmpfs volumes for $name', async (testCase) => {
    const { customImage, persistentWorkspace, memoryLimit, sizeLimits } = testCase
    const standardImage = 'registry.example/agents-codex-runner:standard'
    setEnv('AGENTS_AGENT_RUNNER_IMAGE', standardImage)
    setEnv('AGENTS_AGENT_RUNNER_RESOURCES', JSON.stringify({ limits: { memory: '32Gi' } }))
    setEnv('AGENTS_CONTROLLER_AUTH_SECRET_NAME', 'codex-auth')
    setEnv('AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH', '/root/.codex')
    const kube = {
      get: vi.fn(async () => null),
      apply: vi.fn(async (resource: Record<string, unknown>) => resource),
    }
    const workload: Record<string, unknown> = {}
    if (memoryLimit) workload.resources = { limits: { memory: memoryLimit } }
    if (persistentWorkspace) {
      workload.volumes = [
        { type: 'pvc', name: 'worktree', claimName: 'worktree-pvc', mountPath: '/workspace' },
        { type: 'pvc', name: 'bun-install', claimName: 'bun-install-pvc', mountPath: '/opt/bun/install' },
      ]
    }

    await submitJobRun(
      kube as never,
      { metadata: { name: 'run-1', namespace: 'agents' }, spec: { workload } },
      { metadata: { name: 'agent-a' }, spec: {} },
      { metadata: { name: 'codex' }, spec: {} },
      { summary: 'Run summary' },
      null,
      'agents',
      customImage ? 'registry.example/custom-runner:tag' : standardImage,
      'job',
    )

    const podSpec = readJobPodSpec(kube.apply.mock.calls.find(([resource]) => resource.kind === 'Job')?.[0])
    const volumes = podSpec.volumes as { name: string; emptyDir?: { medium?: string; sizeLimit?: string } }[]
    const [container] = podSpec.containers as {
      volumeMounts: { name: string; mountPath: string }[]
      resources: { limits: { memory: string } }
    }[]
    const memoryLimits = new Map(
      volumes
        .filter((volume) => volume.emptyDir?.medium === 'Memory')
        .map((volume) => [volume.name, volume.emptyDir?.sizeLimit]),
    )
    expect(container.resources.limits.memory).toBe(memoryLimit ?? '32Gi')
    expect(
      Object.fromEntries(
        container.volumeMounts
          .filter((mount) => memoryLimits.has(mount.name))
          .map((mount) => [mount.mountPath, memoryLimits.get(mount.name)]),
      ),
    ).toStrictEqual(sizeLimits)
    if (persistentWorkspace) {
      expect(container.volumeMounts.filter((mount) => mount.mountPath === '/workspace')).toEqual([
        { name: 'worktree', mountPath: '/workspace', readOnly: false },
      ])
    }
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

  it('builds agy-cli jobs without codex-auth while mounting /root/.gemini and provider secretEnv', async () => {
    setEnv('AGENTS_CONTROLLER_AUTH_SECRET_NAME', 'codex-auth')
    setEnv('AGENTS_CONTROLLER_AUTH_SECRET_KEY', 'auth.json')
    setEnv('AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH', '/root/.codex')

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
      { metadata: { name: 'google-run-1', uid: 'google-uid-1', namespace: 'agents' }, spec: {} },
      { metadata: { name: 'google-agent' }, spec: {} },
      {
        metadata: { name: 'google' },
        spec: {
          binary: '/usr/local/bin/agent-runner',
          adapter: {
            type: 'agy-cli',
            agy: {
              model: 'gemini-4-neon',
              effort: 'high',
              cwd: '/workspace/lab',
              quotaProject: 'proompteng',
              location: 'global',
            },
          },
          secretEnv: [
            {
              name: 'GOOGLE_APPLICATION_CREDENTIALS_JSON',
              secretName: 'google-adc-auth',
              key: 'credentials.json',
            },
          ],
        },
      },
      { text: 'Verify Gemini 4 Neon runner' },
      null,
      'agents',
      'registry.example/agents-codex-runner:standard',
      'job',
    )

    const specConfigMap = applied.find((resource) => resource.kind === 'ConfigMap') as
      | { data?: Record<string, string> }
      | undefined
    const runnerSpec = JSON.parse(specConfigMap?.data?.['agent-runner.json'] ?? '{}') as Record<string, unknown>
    expect(runnerSpec.adapter).toEqual({
      type: 'agy-cli',
      agy: {
        cwd: '/workspace/lab',
        model: 'gemini-4-neon',
        effort: 'high',
        dangerouslySkipPermissions: true,
        prompt: 'Verify Gemini 4 Neon runner',
        adcAuth: true,
        quotaProject: 'proompteng',
        location: 'global',
      },
    })

    const job = applied.find((resource) => resource.kind === 'Job') as {
      spec: {
        template: {
          spec: {
            containers: Array<{
              env: Array<{ name: string; value?: string; valueFrom?: Record<string, unknown> }>
              volumeMounts: Array<{ name: string; mountPath: string }>
            }>
            volumes: Array<{ name: string; secret?: { secretName?: string } }>
          }
        }
      }
    }
    const container = job.spec.template.spec.containers[0]
    expect(container.env.find((entry) => entry.name === 'CODEX_HOME')).toBeUndefined()
    expect(container.env.find((entry) => entry.name === 'CODEX_AUTH')).toBeUndefined()
    expect(container.env).toContainEqual({ name: 'AGENT_RUN_NAMESPACE', value: 'agents' })
    expect(container.env).toContainEqual({ name: 'AGENT_RUN_UID', value: 'google-uid-1' })
    expect(container.env).toContainEqual({
      name: 'GOOGLE_APPLICATION_CREDENTIALS_JSON',
      valueFrom: { secretKeyRef: { name: 'google-adc-auth', key: 'credentials.json' } },
    })
    expect(container.volumeMounts.find((mount) => mount.mountPath === '/root/.codex/auth.json')).toBeUndefined()
    expect(container.volumeMounts.find((mount) => mount.mountPath === '/root/.gemini')).toBeDefined()
    expect(job.spec.template.spec.volumes.find((vol) => vol.secret?.secretName === 'codex-auth')).toBeUndefined()
  })

  it('applies validated parameters.model and parameters.effort overrides for agy-cli and preserves unspecified defaults', async () => {
    const applied: Record<string, unknown>[] = []
    const kube = {
      get: vi.fn(async () => null),
      apply: vi.fn(async (resource: Record<string, unknown>) => {
        applied.push(resource)
        return resource
      }),
    }

    const provider = {
      metadata: { name: 'google' },
      spec: {
        binary: '/usr/local/bin/agent-runner',
        adapter: {
          type: 'agy-cli',
          agy: {
            model: 'gemini-4-neon',
            effort: 'high',
            cwd: '/workspace/lab',
            allowedModels: ['gemini-4-neon', 'gemini-2.5-pro'],
            allowedEfforts: ['low', 'medium', 'high', 'xhigh'],
          },
        },
      },
    }

    await submitJobRun(
      kube as never,
      {
        metadata: { name: 'google-override-both', uid: 'uid-both', namespace: 'agents' },
        spec: { parameters: { model: 'gemini-2.5-pro', effort: 'xhigh' } },
      },
      { metadata: { name: 'google-agent' }, spec: {} },
      provider,
      { text: 'Run with overridden model and effort' },
      null,
      'agents',
      'registry.example/agents-codex-runner:standard',
      'job',
    )

    const bothSpecCm = applied.find(
      (resource) =>
        resource.kind === 'ConfigMap' &&
        (resource.metadata as Record<string, unknown>)?.name === 'google-override-both-spec',
    ) as { data?: Record<string, string> } | undefined
    const bothRunnerSpec = JSON.parse(bothSpecCm?.data?.['agent-runner.json'] ?? '{}') as {
      adapter?: { type?: string; agy?: Record<string, unknown> }
    }
    expect(bothRunnerSpec.adapter).toEqual({
      type: 'agy-cli',
      agy: {
        cwd: '/workspace/lab',
        model: 'gemini-2.5-pro',
        effort: 'xhigh',
        dangerouslySkipPermissions: true,
        prompt: 'Run with overridden model and effort',
        adcAuth: true,
        location: 'global',
      },
    })
    expect(bothRunnerSpec.adapter?.agy).not.toHaveProperty('allowedModels')
    expect(bothRunnerSpec.adapter?.agy).not.toHaveProperty('allowedEfforts')

    await submitJobRun(
      kube as never,
      {
        metadata: { name: 'google-override-effort-only', uid: 'uid-effort', namespace: 'agents' },
        spec: { parameters: { effort: 'low' } },
      },
      { metadata: { name: 'google-agent' }, spec: {} },
      provider,
      { text: 'Run with overridden effort only' },
      null,
      'agents',
      'registry.example/agents-codex-runner:standard',
      'job',
    )

    const effortOnlySpecCm = applied.find(
      (resource) =>
        resource.kind === 'ConfigMap' &&
        (resource.metadata as Record<string, unknown>)?.name === 'google-override-effort-only-spec',
    ) as { data?: Record<string, string> } | undefined
    const effortOnlyRunnerSpec = JSON.parse(effortOnlySpecCm?.data?.['agent-runner.json'] ?? '{}') as {
      adapter?: { agy?: Record<string, unknown> }
    }
    expect(effortOnlyRunnerSpec.adapter?.agy?.model).toBe('gemini-4-neon')
    expect(effortOnlyRunnerSpec.adapter?.agy?.effort).toBe('low')
  })

  it('applies validated parameters.model and parameters.effort overrides for codex-app-server', async () => {
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
        metadata: { name: 'codex-override-run', uid: 'uid-codex', namespace: 'agents' },
        spec: { parameters: { model: 'gpt-5.4', effort: 'ultra' } },
      },
      { metadata: { name: 'codex-agent' }, spec: {} },
      {
        metadata: { name: 'codex' },
        spec: {
          binary: '/usr/local/bin/agent-runner',
          adapter: {
            type: 'codex-app-server',
            codex: {
              model: 'gpt-6.2-sol',
              effort: 'max',
              allowedModels: ['gpt-6.2-sol', 'gpt-5.4'],
              allowedEfforts: ['high', 'max', 'ultra'],
            },
          },
        },
      },
      { text: 'Run codex override' },
      null,
      'agents',
      'registry.example/agents-codex-runner:standard',
      'job',
    )

    const specCm = applied.find((resource) => resource.kind === 'ConfigMap') as
      | { data?: Record<string, string> }
      | undefined
    const runnerSpec = JSON.parse(specCm?.data?.['agent-runner.json'] ?? '{}') as {
      adapter?: { codex?: Record<string, unknown> }
    }
    expect(runnerSpec.adapter?.codex?.model).toBe('gpt-5.4')
    expect(runnerSpec.adapter?.codex?.effort).toBe('ultra')
    expect(runnerSpec.adapter?.codex).not.toHaveProperty('allowedModels')
    expect(runnerSpec.adapter?.codex).not.toHaveProperty('allowedEfforts')
  })

  it('rejects invalid or disallowed model/effort overrides in submitJobRun before applying resources', async () => {
    const kube = {
      get: vi.fn(async () => null),
      apply: vi.fn(async (resource: Record<string, unknown>) => resource),
    }

    const googleProvider = {
      metadata: { name: 'google' },
      spec: {
        binary: '/usr/local/bin/agent-runner',
        adapter: {
          type: 'agy-cli',
          agy: {
            model: 'gemini-4-neon',
            effort: 'high',
            allowedModels: ['gemini-4-neon'],
          },
        },
      },
    }

    await expect(
      submitJobRun(
        kube as never,
        {
          metadata: { name: 'google-bad-flag', namespace: 'agents' },
          spec: { parameters: { model: '--dangerously-skip-permissions' } },
        },
        { metadata: { name: 'google-agent' }, spec: {} },
        googleProvider,
        { text: 'Should fail' },
        null,
        'agents',
        'registry.example/agents-codex-runner:standard',
        'job',
      ),
    ).rejects.toThrow('InvalidModelOverride')

    await expect(
      submitJobRun(
        kube as never,
        {
          metadata: { name: 'google-disallowed-model', namespace: 'agents' },
          spec: { parameters: { model: 'gemini-2.5-pro' } },
        },
        { metadata: { name: 'google-agent' }, spec: {} },
        googleProvider,
        { text: 'Should fail' },
        null,
        'agents',
        'registry.example/agents-codex-runner:standard',
        'job',
      ),
    ).rejects.toThrow('ModelOverrideNotAllowed')

    await expect(
      submitJobRun(
        kube as never,
        {
          metadata: { name: 'google-bad-effort', namespace: 'agents' },
          spec: { parameters: { effort: 'ultra' } },
        },
        { metadata: { name: 'google-agent' }, spec: {} },
        googleProvider,
        { text: 'Should fail' },
        null,
        'agents',
        'registry.example/agents-codex-runner:standard',
        'job',
      ),
    ).rejects.toThrow('InvalidEffortOverride')

    expect(kube.apply).not.toHaveBeenCalled()
  })
})
