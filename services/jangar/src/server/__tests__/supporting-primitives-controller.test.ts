import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('~/server/feature-flags', () => ({
  resolveBooleanFeatureToggle: vi.fn(async () => true),
}))

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

const kubeWatchMocks = vi.hoisted(() => ({
  startResourceWatch: vi.fn(() => ({ stop: vi.fn() })),
}))

const primitivesKubeMocks = vi.hoisted(() => ({
  createKubernetesClient: vi.fn(),
}))

const runtimeAdmissionMocks = vi.hoisted(() => ({
  buildRuntimeAdmissionSnapshot: vi.fn(),
}))

vi.mock('node:child_process', () => childProcessMocks)
vi.mock('~/server/kube-watch', () => kubeWatchMocks)
vi.mock('~/server/primitives-kube', async () => {
  const actual = await vi.importActual<typeof import('~/server/primitives-kube')>('~/server/primitives-kube')
  return {
    ...actual,
    createKubernetesClient: primitivesKubeMocks.createKubernetesClient,
  }
})
vi.mock('~/server/control-plane-runtime-admission', async () => {
  const actual = await vi.importActual<typeof import('~/server/control-plane-runtime-admission')>(
    '~/server/control-plane-runtime-admission',
  )
  return {
    ...actual,
    buildRuntimeAdmissionSnapshot: runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot,
  }
})

import * as agentsControllerModule from '~/server/agents-controller'
import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import { asString } from '~/server/primitives-http'
import type { KubernetesClient } from '~/server/primitives-kube'
import { RESOURCE_MAP } from '~/server/primitives-kube'
import {
  __test__,
  startSupportingPrimitivesController,
  stopSupportingPrimitivesController,
} from '~/server/supporting-primitives-controller'

const TEST_RUNNER_IMAGE =
  'registry.ide-newton.ts.net/lab/jangar:test@sha256:1111111111111111111111111111111111111111111111111111111111111111'

const createMockKubectlProcess = (code: number, options: { stderr?: string; stdout?: string } = {}) => {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void }
  const stderrStream = new EventEmitter() as EventEmitter & { setEncoding: () => void }
  stdout.setEncoding = () => {}
  stderrStream.setEncoding = () => {}

  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout
    stderr: typeof stderrStream
    kill: () => void
  }
  child.stdout = stdout
  child.stderr = stderrStream
  child.kill = () => {}

  queueMicrotask(() => {
    if (options.stdout) {
      stdout.emit('data', options.stdout)
    }
    if (options.stderr) {
      stderrStream.emit('data', options.stderr)
    }
    child.emit('close', code)
  })

  return child
}

const requirementIdForSignal = (signalNamespace: string, signalName: string) => {
  const value = `${signalNamespace}/${signalName}`
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash).toString(36).padStart(8, '0').slice(0, 8)
}

const buildAdmissionPassport = (
  consumerClass: 'serving' | 'swarm_plan' | 'swarm_implement' | 'swarm_verify',
  overrides: Record<string, unknown> = {},
) => ({
  admission_passport_id: `passport:${consumerClass}:test`,
  consumer_class: consumerClass,
  authority_session_id: 'authority-session:test',
  recovery_case_set_digest: 'recovery-digest-test',
  runtime_kit_set_digest: `runtime-digest:${consumerClass}`,
  decision: 'allow',
  reason_codes: [],
  required_subjects: [],
  required_runtime_kits: [`runtime-kit:${consumerClass}:test`],
  issued_at: '2026-01-20T00:00:00.000Z',
  fresh_until: '2026-01-20T00:05:00.000Z',
  producer_revision: 'test-producer-revision',
  ...overrides,
})

const WARRANT_CLASSES_BY_CONSUMER = {
  serving: ['serving'],
  swarm_plan: ['discover', 'plan'],
  swarm_implement: ['collaboration', 'implement'],
  swarm_verify: ['verify'],
} as const

const buildRuntimeProofCell = (
  recoveryWarrantId: string,
  executionClass: string,
  overrides: Record<string, unknown> = {},
) => ({
  runtime_proof_cell_id: `runtime-proof-cell:${executionClass}:test`,
  recovery_warrant_id: recoveryWarrantId,
  runtime_kit_id: `runtime-kit:${executionClass}:test`,
  proof_kind: 'runtime_kit',
  proof_subject: `runtime-kit:${executionClass}:test`,
  expected_ref: 'runtime-digest-test',
  observed_ref: 'healthy',
  artifact_ref: `runtime-kit:${executionClass}:test`,
  content_hash: 'runtime-digest-test',
  status: 'healthy',
  required: true,
  reason_codes: [],
  observed_at: '2026-01-20T00:00:00.000Z',
  expires_at: '2026-01-20T00:05:00.000Z',
  ...overrides,
})

const buildRecoveryWarrant = (
  passport: ReturnType<typeof buildAdmissionPassport>,
  executionClass: string,
  overrides: Record<string, unknown> = {},
) => {
  const recoveryWarrantId = `recovery-warrant:${executionClass}:test`
  return {
    recovery_warrant_id: recoveryWarrantId,
    recovery_epoch_id: `recovery-epoch:${executionClass}:test`,
    swarm_name: 'jangar-control-plane',
    execution_class: executionClass,
    admitted_revision: passport.producer_revision,
    admitted_image_digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    runtime_kit_digest: passport.runtime_kit_set_digest,
    admission_passport_id: passport.admission_passport_id,
    required_proof_cell_ids: [`runtime-proof-cell:${executionClass}:test`],
    active_backlog_seat_count: 0,
    projection_watermark_ids: [`projection-watermark:${executionClass}:deploy`],
    status: 'sealed',
    opened_at: '2026-01-20T00:00:00.000Z',
    sealed_at: '2026-01-20T00:00:00.000Z',
    superseded_at: null,
    reason_codes: [],
    ...overrides,
  }
}

const buildAdmissionSnapshot = (
  overrides: Record<string, Record<string, unknown>> = {},
  warrantOverrides: Record<string, Record<string, unknown>> = {},
  proofCellOverrides: Record<string, Record<string, unknown>> = {},
) => {
  const admissionPassports = [
    buildAdmissionPassport('serving', overrides.serving ?? {}),
    buildAdmissionPassport('swarm_plan', overrides.swarm_plan ?? {}),
    buildAdmissionPassport('swarm_implement', overrides.swarm_implement ?? {}),
    buildAdmissionPassport('swarm_verify', overrides.swarm_verify ?? {}),
  ]
  const recoveryWarrants = admissionPassports.flatMap((passport) =>
    WARRANT_CLASSES_BY_CONSUMER[passport.consumer_class].map((executionClass) =>
      buildRecoveryWarrant(passport, executionClass, warrantOverrides[executionClass] ?? {}),
    ),
  )
  const runtimeProofCells = recoveryWarrants.flatMap((warrant) =>
    warrant.required_proof_cell_ids.map((proofCellId) =>
      buildRuntimeProofCell(
        warrant.recovery_warrant_id,
        warrant.execution_class,
        Object.assign({ runtime_proof_cell_id: proofCellId }, proofCellOverrides[warrant.execution_class]),
      ),
    ),
  )

  return {
    runtimeKits: [],
    admissionPassports,
    servingPassportId: 'passport:serving:test',
    recoveryWarrants,
    runtimeProofCells,
    projectionWatermarks: [],
  }
}

describe('supporting primitives controller', () => {
  let resolveSwarmAvailability: (resource: string, call: number) => { code: number; stderr?: string } = () => ({
    code: 0,
  })
  let kubectlCalls = new Map<string, number>()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:00Z'))
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(buildAdmissionSnapshot())
    kubectlCalls = new Map()
    resolveSwarmAvailability = (resource, call) => {
      if (resource === 'swarms' && call === 1) {
        return {
          code: 1,
          stderr: 'error: the server does not have a resource type "swarms.swarm.proompteng.ai"',
        }
      }
      return { code: 0 }
    }
    childProcessMocks.spawn.mockImplementation((_, args: string[] = []) => {
      const resource = typeof args[1] === 'string' ? args[1] : ''
      const normalizedResource = resource.split('.').at(0) ?? resource
      const count = (kubectlCalls.get(resource) ?? 0) + 1
      kubectlCalls.set(resource, count)
      const result = resolveSwarmAvailability(normalizedResource, count)
      return createMockKubectlProcess(result.code, {
        stderr: result.stderr,
        stdout: result.code === 0 ? JSON.stringify({ items: [] }) : undefined,
      })
    })
    primitivesKubeMocks.createKubernetesClient.mockImplementation(
      () =>
        ({
          list: vi.fn(async (resource: string) => {
            const count = (kubectlCalls.get(resource) ?? 0) + 1
            kubectlCalls.set(resource, count)
            const normalizedResource = resource.split('.').at(0) ?? resource
            const result = resolveSwarmAvailability(normalizedResource, count)
            if (result.code !== 0) {
              throw new Error(result.stderr ?? `failed to list ${resource}`)
            }
            return { items: [] }
          }),
        }) as unknown as KubernetesClient,
    )
    process.env.JANGAR_AGENT_RUNNER_IMAGE = TEST_RUNNER_IMAGE
    delete process.env.JANGAR_AGENT_RUNNER_NODE_SELECTOR
    delete process.env.JANGAR_SCHEDULE_RUNNER_NODE_SELECTOR
    delete process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_CHECK
    delete process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_URL
    delete process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_TIMEOUT_MS
    delete process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED
    delete process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY
    delete process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT
    delete process.env.JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT
  })

  afterEach(() => {
    vi.restoreAllMocks()
    stopSupportingPrimitivesController()
    agentsControllerModule.stopAgentsController()
    vi.useRealTimers()
    delete process.env.JANGAR_AGENT_RUNNER_IMAGE
    delete process.env.JANGAR_AGENT_RUNNER_NODE_SELECTOR
    delete process.env.JANGAR_SCHEDULE_RUNNER_NODE_SELECTOR
    delete process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_CHECK
    delete process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_URL
    delete process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_TIMEOUT_MS
    delete process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT
    delete process.env.JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT
  })

  it('sets standard conditions and updatedAt for invalid tools', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { applyStatus } as unknown as KubernetesClient

    const tool = {
      apiVersion: 'tools.proompteng.ai/v1alpha1',
      kind: 'Tool',
      metadata: { name: 'bad-tool', namespace: 'agents', generation: 1 },
      spec: {},
    }

    await __test__.reconcileTool(kube, tool)

    expect(applyStatus).toHaveBeenCalledTimes(1)
    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    const status = payload.status ?? {}

    expect(status.updatedAt).toBe('2026-01-20T00:00:00.000Z')

    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const ready = conditions.find((condition) => condition.type === 'Ready')
    const progressing = conditions.find((condition) => condition.type === 'Progressing')
    const degraded = conditions.find((condition) => condition.type === 'Degraded')

    expect(ready?.status).toBe('False')
    expect(progressing?.status).toBe('False')
    expect(degraded?.status).toBe('True')
  })

  it('reconciles workspace storage through the persistent volume claim resource alias', async () => {
    const apply = vi.fn().mockResolvedValue({})
    const applyStatus = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.PersistentVolumeClaim) {
        return {
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          metadata: { name: 'workspace-1', namespace: 'agents' },
          spec: { volumeName: 'pvc-123' },
          status: { phase: 'Bound' },
        }
      }
      return null
    })
    const kube = { apply, applyStatus, get } as unknown as KubernetesClient
    const workspace = {
      apiVersion: 'workspaces.proompteng.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'workspace-1', namespace: 'agents', generation: 3, uid: 'workspace-uid' },
      spec: {
        size: '10Gi',
        accessModes: ['ReadWriteOnce'],
      },
    }

    await __test__.reconcileWorkspace(kube, workspace, 'agents')

    expect(get).toHaveBeenCalledWith(RESOURCE_MAP.PersistentVolumeClaim, 'workspace-1', 'agents')
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: expect.objectContaining({
          name: 'workspace-1',
          namespace: 'agents',
          labels: { 'workspaces.proompteng.ai/workspace': 'workspace-1' },
        }),
      }),
    )
    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Ready')
    expect(status.volumeName).toBe('pvc-123')
  })

  it('builds schedule runner command with runtime delivery id substitution', async () => {
    const command = __test__.buildScheduleRunnerCommand()

    expect(command).toContain("const { randomUUID } = await import('node:crypto');")
    expect(command).toContain("const { readFileSync } = await import('node:fs');")
    expect(command).toContain("const { request } = await import('node:https');")
    expect(command).not.toContain("node:crypto' import")
    expect(command.split('\n').slice(0, 4)).toEqual([
      'void (async () => {',
      "  const { randomUUID } = await import('node:crypto');",
      "  const { readFileSync } = await import('node:fs');",
      "  const { request } = await import('node:https');",
    ])
    expect(command).toContain("replaceAll('__JANGAR_DELIVERY_ID__', randomUUID())")
    expect(command).toContain('JANGAR_SCHEDULE_RUNNER_ADMISSION_CHECK')
    expect(command).toContain('JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT')
    expect(command).toContain('JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_URL')
    expect(command).toContain('missing schedule admission passport annotation for')
    expect(command).not.toContain('stale schedule admission passport')
    expect(command).not.toContain('stale schedule runtime-kit digest')
    expect(command).not.toContain('stale schedule recovery-case digest')
    expect(command).not.toContain('stale schedule required runtime kits')
    expect(command).toContain(
      'writeNestedRecordValue(manifest, ["metadata", "annotations"], admissionAnnotations.passportId',
    )
    expect(command).toContain(
      'writeNestedRecordValue(manifest, ["metadata", "annotations"], admissionAnnotations.runtimeDigest',
    )
    expect(command).toContain('writeNestedRecordValue(manifest, ["spec", "parameters"], "swarmAdmissionPassportId"')
    expect(command).toContain('writeNestedRecordValue(manifest, ["spec", "parameters"], "swarmRecoveryWarrantId"')
    expect(command).toContain('writeNestedRecordValue(manifest, ["spec", "parameters"], "swarmRuntimeKitSetDigest"')
    expect(command).toContain('current schedule recovery warrant')
    expect(command).toContain('runtime proof cell')
    expect(command).toContain('current schedule admission runtime kit')
    expect(command).toContain('const targetByKind = {')
    expect(command).toContain("method: 'POST'")
    expect(command).toContain(
      'const namespace = String((manifest?.metadata?.namespace ?? readEnv("JANGAR_POD_NAMESPACE")) || \'agents\');',
    )
    expect(command).not.toContain("from 'node:crypto'\nimport")
    expect(command).not.toContain("from 'node:crypto' import")
    expect(command).not.toContain('?? readEnv("JANGAR_POD_NAMESPACE") ||')
    expect(command).not.toContain('kubectl create -f -')

    const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const syntaxCheck = spawnSync('bun', ['-e', command], { encoding: 'utf8' })
    const stderr = syntaxCheck.stderr.toString()
    expect(stderr).not.toContain('Unexpected ||')
    expect(stderr).toContain('/config/run.json')
    expect(() => new Function(command)).not.toThrow()
    expect(() => new Function(command.replace(/\s+/g, ' '))).not.toThrow()
  })

  it('staggers hourly stage cadence deterministically per stage', () => {
    const discoverCron = __test__.cadenceToCron('1h', { swarmName: 'jangar-control-plane', stage: 'discover' })
    const planCron = __test__.cadenceToCron('1h', { swarmName: 'jangar-control-plane', stage: 'plan' })
    const implementCron = __test__.cadenceToCron('1h', { swarmName: 'jangar-control-plane', stage: 'implement' })
    const verifyCron = __test__.cadenceToCron('1h', { swarmName: 'jangar-control-plane', stage: 'verify' })

    expect(discoverCron).toMatch(/^\d{1,2} \* \* \* \*$/)
    expect(planCron).toMatch(/^\d{1,2} \* \* \* \*$/)
    expect(implementCron).toMatch(/^\d{1,2} \* \* \* \*$/)
    expect(verifyCron).toMatch(/^\d{1,2} \* \* \* \*$/)
    expect(new Set([discoverCron, planCron, implementCron, verifyCron]).size).toBe(4)
  })

  it('normalizes requirement priority from payload and labels', () => {
    expect(
      __test__.resolveRequirementPriorityScore({
        spec: { payload: { priority: 'critical' } },
      } as Record<string, unknown>),
    ).toBe(0)
    expect(
      __test__.resolveRequirementPriorityScore({
        spec: { payload: { priority: 'low' } },
      } as Record<string, unknown>),
    ).toBe(3)
    expect(
      __test__.resolveRequirementPriorityScore({
        metadata: { labels: { priority: 'high' } },
        spec: {},
      } as Record<string, unknown>),
    ).toBe(1)
  })

  it('deduplicates explicit schedule run template secrets without injecting collaboration secrets', () => {
    const schedule = {
      metadata: {
        name: 'torghut-quant-discover-sched',
        namespace: 'agents',
        labels: {
          'swarm.proompteng.ai/name': 'torghut-quant',
        },
      },
    } as Record<string, unknown>
    const target = {
      kind: 'AgentRun',
      metadata: { namespace: 'agents' },
      spec: {
        agentRef: { name: 'codex-spark-agent' },
        runtime: { type: 'job' },
        secrets: ['codex-auth', 'codex-auth', 'keep-me'],
      },
    } as Record<string, unknown>

    const template = __test__.buildScheduleRunTemplate(schedule, target, '__DELIVERY__')
    const spec = (template as { spec?: Record<string, unknown> }).spec ?? {}
    const secrets = Array.isArray(spec.secrets) ? (spec.secrets as string[]) : []
    expect(secrets).toEqual(['codex-auth', 'keep-me'])
  })

  it('propagates schedule admission trace into generated run templates', () => {
    const schedule = {
      metadata: {
        name: 'jangar-control-plane-plan-sched',
        namespace: 'agents',
        labels: {
          'swarm.proompteng.ai/name': 'jangar-control-plane',
        },
        annotations: {
          'swarm.proompteng.ai/admission-passport-id': 'passport:swarm_plan:test',
          'swarm.proompteng.ai/admission-decision': 'allow',
          'swarm.proompteng.ai/recovery-case-set-digest': 'recovery-digest-test',
          'swarm.proompteng.ai/runtime-kit-set-digest': 'runtime-digest:swarm_plan',
          'swarm.proompteng.ai/required-runtime-kits': 'runtime-kit:swarm_plan:test',
          'swarm.proompteng.ai/admission-producer-revision': 'test-producer-revision',
        },
      },
    } as Record<string, unknown>
    const target = {
      kind: 'AgentRun',
      metadata: { namespace: 'agents' },
      spec: {
        agentRef: { name: 'codex-spark-agent' },
        runtime: { type: 'job' },
      },
    } as Record<string, unknown>

    const template = __test__.buildScheduleRunTemplate(schedule, target, '__DELIVERY__') as {
      metadata?: Record<string, unknown>
      spec?: Record<string, unknown>
    }

    expect(template.metadata?.annotations).toMatchObject({
      'swarm.proompteng.ai/admission-passport-id': 'passport:swarm_plan:test',
      'swarm.proompteng.ai/admission-decision': 'allow',
      'swarm.proompteng.ai/runtime-kit-set-digest': 'runtime-digest:swarm_plan',
    })
    expect(template.spec?.parameters).toMatchObject({
      swarmAdmissionPassportId: 'passport:swarm_plan:test',
      swarmAdmissionDecision: 'allow',
      swarmRecoveryCaseSetDigest: 'recovery-digest-test',
      swarmRuntimeKitSetDigest: 'runtime-digest:swarm_plan',
      swarmRequiredRuntimeKits: 'runtime-kit:swarm_plan:test',
      swarmAdmissionProducerRevision: 'test-producer-revision',
    })
  })

  it('blocks swarm schedule runners when the current stage passport is not allowed', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildAdmissionSnapshot({
        swarm_plan: {
          decision: 'hold',
          reason_codes: ['runtime_kit_component_missing:nats_cli'],
        },
      }),
    )

    const apply = vi.fn().mockResolvedValue({})
    const applyStatus = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { apply, applyStatus, get, delete: deleteFn } as unknown as KubernetesClient
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-plan-sched',
        namespace: 'agents',
        generation: 4,
        labels: {
          'swarm.proompteng.ai/name': 'jangar-control-plane',
          'swarm.proompteng.ai/stage': 'plan',
        },
        annotations: {
          'swarm.proompteng.ai/nats-url': 'nats://nats.nats.svc.cluster.local:4222',
        },
      },
      spec: {
        cron: '*/10 * * * *',
        targetRef: { kind: 'AgentRun', name: 'agentrun-plan-template', namespace: 'agents' },
      },
    }

    await __test__.reconcileSchedule(kube, schedule, 'agents')

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledWith('configmap', 'jangar-control-plane-plan-sched-template', 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith('cronjob', 'jangar-control-plane-plan-sched-cron', 'agents', {
      wait: false,
    })
    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('AdmissionBlocked')
    const ready = (Array.isArray(status.conditions) ? status.conditions : []).find(
      (condition) => condition.type === 'Ready',
    )
    expect(ready?.reason).toBe('RuntimeAdmissionBlocked')
    expect(String(ready?.message)).toContain('runtime_kit_component_missing:nats_cli')
  })

  it('fails closed and deletes schedule runners when admission snapshots are unavailable', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockImplementation(() => {
      throw new Error('runtime admission database unavailable')
    })

    const apply = vi.fn().mockResolvedValue({})
    const applyStatus = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { apply, applyStatus, get, delete: deleteFn } as unknown as KubernetesClient
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-plan-sched',
        namespace: 'agents',
        generation: 4,
        labels: {
          'swarm.proompteng.ai/name': 'jangar-control-plane',
          'swarm.proompteng.ai/stage': 'plan',
        },
        annotations: {
          'swarm.proompteng.ai/nats-url': 'nats://nats.nats.svc.cluster.local:4222',
          'swarm.proompteng.ai/admission-passport-id': 'passport:swarm_plan:stale',
        },
      },
      spec: {
        cron: '*/10 * * * *',
        targetRef: { kind: 'AgentRun', name: 'agentrun-plan-template', namespace: 'agents' },
      },
    }

    await __test__.reconcileSchedule(kube, schedule, 'agents')

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledWith('configmap', 'jangar-control-plane-plan-sched-template', 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith('cronjob', 'jangar-control-plane-plan-sched-cron', 'agents', {
      wait: false,
    })
    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('AdmissionBlocked')
    const ready = (Array.isArray(status.conditions) ? status.conditions : []).find(
      (condition) => condition.type === 'Ready',
    )
    expect(ready?.reason).toBe('RuntimeAdmissionUnavailable')
    expect(String(ready?.message)).toContain('runtime admission database unavailable')
  })

  it('refreshes swarm schedule run templates with the current stage passport', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildAdmissionSnapshot({
        swarm_plan: {
          admission_passport_id: 'passport:swarm_plan:current',
          runtime_kit_set_digest: 'runtime-digest:current',
          required_runtime_kits: ['runtime-kit:collaboration:current'],
        },
      }),
    )

    const target = {
      kind: 'AgentRun',
      metadata: { name: 'agentrun-plan-template', namespace: 'agents' },
      spec: {
        agentRef: { name: 'codex-spark-agent' },
        runtime: { type: 'job' },
      },
    }
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) return target
      return null
    })
    const apply = vi.fn().mockResolvedValue({})
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { get, apply, applyStatus, delete: vi.fn() } as unknown as KubernetesClient
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-plan-sched',
        namespace: 'agents',
        generation: 5,
        labels: {
          'swarm.proompteng.ai/name': 'jangar-control-plane',
          'swarm.proompteng.ai/stage': 'plan',
        },
        annotations: {
          'swarm.proompteng.ai/nats-url': 'nats://nats.nats.svc.cluster.local:4222',
          'swarm.proompteng.ai/admission-passport-id': 'passport:swarm_plan:stale',
          'swarm.proompteng.ai/admission-decision': 'allow',
        },
      },
      spec: {
        cron: '*/10 * * * *',
        targetRef: { kind: 'AgentRun', name: 'agentrun-plan-template', namespace: 'agents' },
      },
    }

    await __test__.reconcileSchedule(kube, schedule, 'agents')

    const configMap = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.kind === 'ConfigMap') as { data?: Record<string, string> } | undefined
    const runTemplate = JSON.parse(configMap?.data?.['run.json'] ?? '{}') as {
      metadata?: Record<string, unknown>
      spec?: Record<string, unknown>
    }

    expect(runTemplate.metadata?.annotations).toMatchObject({
      'swarm.proompteng.ai/admission-passport-id': 'passport:swarm_plan:current',
      'swarm.proompteng.ai/admission-decision': 'allow',
      'swarm.proompteng.ai/runtime-kit-set-digest': 'runtime-digest:current',
      'swarm.proompteng.ai/recovery-warrant-id': 'recovery-warrant:plan:test',
      'swarm.proompteng.ai/recovery-warrant-status': 'sealed',
      'swarm.proompteng.ai/required-proof-cells': 'runtime-proof-cell:plan:test',
    })
    expect(runTemplate.spec?.parameters).toMatchObject({
      swarmAdmissionPassportId: 'passport:swarm_plan:current',
      swarmRuntimeKitSetDigest: 'runtime-digest:current',
      swarmRequiredRuntimeKits: 'runtime-kit:collaboration:current',
      swarmRecoveryWarrantId: 'recovery-warrant:plan:test',
      swarmRecoveryWarrantStatus: 'sealed',
      swarmRequiredProofCells: 'runtime-proof-cell:plan:test',
    })
  })

  it('pins schedule runner cronjobs to the configured workload node selector', async () => {
    process.env.JANGAR_AGENT_RUNNER_NODE_SELECTOR = JSON.stringify({ 'kubernetes.io/arch': 'arm64' })

    const target = {
      kind: 'AgentRun',
      metadata: { name: 'agentrun-plan-template', namespace: 'agents' },
      spec: {
        agentRef: { name: 'codex-spark-agent' },
        runtime: { type: 'job' },
      },
    }
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) return target
      return null
    })
    const apply = vi.fn().mockResolvedValue({})
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { get, apply, applyStatus } as unknown as KubernetesClient
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-plan-sched',
        namespace: 'agents',
        generation: 5,
      },
      spec: {
        cron: '*/10 * * * *',
        targetRef: { kind: 'AgentRun', name: 'agentrun-plan-template', namespace: 'agents' },
      },
    }

    await __test__.reconcileSchedule(kube, schedule, 'agents')

    const cronJob = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.kind === 'CronJob') as { spec?: Record<string, unknown> } | undefined
    const podSpec = (
      ((cronJob?.spec?.jobTemplate as Record<string, unknown> | undefined)?.spec as Record<string, unknown> | undefined)
        ?.template as Record<string, unknown> | undefined
    )?.spec as Record<string, unknown> | undefined

    expect(podSpec?.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64' })
  })

  it('passes fire-time admission check settings to schedule runner cronjobs', async () => {
    process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_CHECK = 'false'
    process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_URL =
      'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status'
    process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_TIMEOUT_MS = '2500'

    const target = {
      kind: 'AgentRun',
      metadata: { name: 'agentrun-plan-template', namespace: 'agents' },
      spec: {
        agentRef: { name: 'codex-spark-agent' },
        runtime: { type: 'job' },
      },
    }
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) return target
      return null
    })
    const apply = vi.fn().mockResolvedValue({})
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { get, apply, applyStatus } as unknown as KubernetesClient
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-plan-sched',
        namespace: 'agents',
        generation: 5,
      },
      spec: {
        cron: '*/10 * * * *',
        targetRef: { kind: 'AgentRun', name: 'agentrun-plan-template', namespace: 'agents' },
      },
    }

    await __test__.reconcileSchedule(kube, schedule, 'agents')

    const cronJob = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.kind === 'CronJob') as { spec?: Record<string, unknown> } | undefined
    const podSpec = (
      ((cronJob?.spec?.jobTemplate as Record<string, unknown> | undefined)?.spec as Record<string, unknown> | undefined)
        ?.template as Record<string, unknown> | undefined
    )?.spec as Record<string, unknown> | undefined
    const containers = Array.isArray(podSpec?.containers) ? (podSpec.containers as Record<string, unknown>[]) : []
    const env = containers.find((container) => container.name === 'schedule-runner')?.env

    expect(env).toEqual(
      expect.arrayContaining([
        { name: 'JANGAR_SCHEDULE_NAMESPACE', value: 'agents' },
        { name: 'JANGAR_SCHEDULE_RUNNER_ADMISSION_CHECK', value: 'false' },
        { name: 'JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT', value: 'false' },
        {
          name: 'JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_URL',
          value: 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status',
        },
        { name: 'JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_TIMEOUT_MS', value: '2500' },
      ]),
    )
  })

  it('disables schedule runner fire-time admission during runtime admission rollback', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = 'false'
    process.env.JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT = 'true'
    process.env.JANGAR_SCHEDULE_RUNNER_ADMISSION_CHECK = 'true'

    const target = {
      kind: 'AgentRun',
      metadata: { name: 'agentrun-plan-template', namespace: 'agents' },
      spec: {
        agentRef: { name: 'codex-spark-agent' },
        runtime: { type: 'job' },
      },
    }
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) return target
      return null
    })
    const apply = vi.fn().mockResolvedValue({})
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { get, apply, applyStatus } as unknown as KubernetesClient
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-plan-sched',
        namespace: 'agents',
        generation: 5,
        labels: {
          'swarm.proompteng.ai/name': 'jangar-control-plane',
          'swarm.proompteng.ai/stage': 'plan',
        },
      },
      spec: {
        cron: '*/10 * * * *',
        targetRef: { kind: 'AgentRun', name: 'agentrun-plan-template', namespace: 'agents' },
      },
    }

    await __test__.reconcileSchedule(kube, schedule, 'agents')

    const cronJob = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.kind === 'CronJob') as { spec?: Record<string, unknown> } | undefined
    const podSpec = (
      ((cronJob?.spec?.jobTemplate as Record<string, unknown> | undefined)?.spec as Record<string, unknown> | undefined)
        ?.template as Record<string, unknown> | undefined
    )?.spec as Record<string, unknown> | undefined
    const containers = Array.isArray(podSpec?.containers) ? (podSpec.containers as Record<string, unknown>[]) : []
    const env = containers.find((container) => container.name === 'schedule-runner')?.env

    expect(env).toEqual(
      expect.arrayContaining([
        { name: 'JANGAR_SCHEDULE_RUNNER_ADMISSION_CHECK', value: 'false' },
        { name: 'JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT', value: 'false' },
      ]),
    )
  })

  it('skips apply for equivalent schedule resources', async () => {
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
        annotations: { 'swarm.proompteng.ai/worker-id': 'worker-123' },
        resourceVersion: '123',
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
        targetRef: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          name: 'agentrun-sample',
          namespace: 'agents',
        },
      },
      status: { phase: 'Active' },
    })
    const kube = { apply, get } as unknown as KubernetesClient

    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
        annotations: { 'swarm.proompteng.ai/worker-id': 'worker-123' },
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
        targetRef: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          name: 'agentrun-sample',
          namespace: 'agents',
        },
      },
    }

    await __test__.applyResourceIfChanged(kube, schedule)

    expect(get).toHaveBeenCalledWith(RESOURCE_MAP.Schedule, 'jangar-control-plane-discover-sched', 'agents')
    expect(apply).not.toHaveBeenCalled()
  })

  it('skips apply when live resource has extra defaulted fields outside desired spec', async () => {
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: {
          'swarm.proompteng.ai/name': 'jangar-control-plane',
          'controller-runtime': 'defaulted',
        },
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
        targetRef: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          name: 'agentrun-sample',
          namespace: 'agents',
          uid: 'defaulted-uid',
        },
      },
    })
    const kube = { apply, get } as unknown as KubernetesClient

    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
        targetRef: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          name: 'agentrun-sample',
          namespace: 'agents',
        },
      },
    }

    await __test__.applyResourceIfChanged(kube, schedule)

    expect(apply).not.toHaveBeenCalled()
  })

  it('applies schedule when desired spec differs from live resource', async () => {
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
      },
      spec: {
        cron: '*/10 * * * *',
        timezone: 'UTC',
      },
    })
    const kube = { apply, get } as unknown as KubernetesClient

    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
      },
    }

    await __test__.applyResourceIfChanged(kube, schedule)

    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('resolves watched resources only for controller-managed kinds', () => {
    expect(__test__.resolveWatchedResourceForKind('Swarm')).toBe(RESOURCE_MAP.Swarm)
    expect(__test__.resolveWatchedResourceForKind('Schedule')).toBe(RESOURCE_MAP.Schedule)
    expect(__test__.resolveWatchedResourceForKind('Artifact')).toBe(RESOURCE_MAP.Artifact)
    expect(__test__.resolveWatchedResourceForKind('ConfigMap')).toBeNull()
  })

  it('identifies swarm status-only modified events', () => {
    const swarm = {
      kind: 'Swarm',
      metadata: { generation: 7 },
      status: { observedGeneration: 7 },
    }

    expect(__test__.isSwarmStatusOnlyEvent('MODIFIED', swarm)).toBe(true)
    expect(__test__.isSwarmStatusOnlyEvent('ADDED', swarm)).toBe(false)
    expect(__test__.isSwarmStatusOnlyEvent('MODIFIED', { ...swarm, status: { observedGeneration: 6 } })).toBe(false)
  })

  it('throttles swarm status-only reconciles within the guard interval', () => {
    const key = 'agents/Swarm/jangar-control-plane'
    const startMs = 1_000

    expect(__test__.shouldThrottleSwarmStatusReconcile(key, startMs)).toBe(false)
    expect(
      __test__.shouldThrottleSwarmStatusReconcile(key, startMs + __test__.SWARM_STATUS_ONLY_RECONCILE_INTERVAL_MS - 1),
    ).toBe(true)
    expect(
      __test__.shouldThrottleSwarmStatusReconcile(key, startMs + __test__.SWARM_STATUS_ONLY_RECONCILE_INTERVAL_MS),
    ).toBe(false)
  })

  it('throttles schedule runner status reconciles within the guard interval', () => {
    const key = 'agents/Schedule/jangar-control-plane-plan-sched'
    const startMs = 1_000

    expect(__test__.shouldThrottleScheduleRunnerStatusReconcile(key, startMs)).toBe(false)
    expect(
      __test__.shouldThrottleScheduleRunnerStatusReconcile(
        key,
        startMs + __test__.SCHEDULE_RUNNER_STATUS_RECONCILE_INTERVAL_MS - 1,
      ),
    ).toBe(true)
    expect(
      __test__.shouldThrottleScheduleRunnerStatusReconcile(
        key,
        startMs + __test__.SCHEDULE_RUNNER_STATUS_RECONCILE_INTERVAL_MS,
      ),
    ).toBe(false)
  })

  it('reconciles schedule runner status without full schedule apply path', async () => {
    const get = vi.fn(async (resource: string) => {
      if (resource === 'cronjob') {
        return { status: { lastScheduleTime: '2026-01-20T00:10:00Z' } }
      }
      return null
    })
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { get, applyStatus } as unknown as KubernetesClient
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: { name: 'schedule-a', namespace: 'agents', generation: 3 },
      status: { conditions: [] },
    }

    await __test__.reconcileScheduleRunnerStatus(kube, schedule, 'agents')

    expect(get).toHaveBeenCalledWith('cronjob', 'schedule-a-cron', 'agents')
    expect(applyStatus).toHaveBeenCalledTimes(1)
    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    expect(payload.status?.phase).toBe('Active')
    expect(payload.status?.lastRunTime).toBe('2026-01-20T00:10:00Z')
  })

  it('reconciles schedules that target an updated AgentRun template', async () => {
    const template = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        name: 'torghut-swarm-discover-template',
        namespace: 'agents',
        annotations: { 'agents.proompteng.ai/template': 'true' },
      },
      spec: {
        agentRef: { name: 'codex-spark-agent' },
        implementationSpecRef: { name: 'swarm-intelligence-cycle-v1' },
        runtime: { type: 'workflow', config: { serviceAccountName: 'agents-sa' } },
        workflow: {
          steps: [
            {
              name: 'discover',
              retries: 1,
              retryBackoffSeconds: 30,
              parameters: { stage: 'research' },
            },
          ],
        },
        parameters: { repository: 'proompteng/lab' },
      },
    }
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'torghut-quant-discover-sched',
        namespace: 'agents',
        generation: 1,
        annotations: {
          'swarm.proompteng.ai/mission-ledger-ref': '/workspace/.agentrun/swarm/torghut-quant-mission-ledger.md',
          'swarm.proompteng.ai/business-metric': 'increase routeable post-cost profit evidence',
          'swarm.proompteng.ai/validation-contract': JSON.stringify(['prove trading evidence status']),
          'swarm.proompteng.ai/value-gates': JSON.stringify(['routeable_candidate_count']),
          'swarm.proompteng.ai/handoff-fields': JSON.stringify(['objective', 'exact_next_action']),
          'swarm.proompteng.ai/source-design': 'docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md',
        },
      },
      spec: {
        cron: '7 * * * *',
        timezone: 'UTC',
        targetRef: { kind: 'AgentRun', name: 'torghut-swarm-discover-template', namespace: 'agents' },
      },
      status: { conditions: [] },
    }
    const applied: Record<string, unknown>[] = []
    const kube = {
      list: vi.fn(async (resource: string) =>
        resource === RESOURCE_MAP.Schedule ? { items: [schedule] } : { items: [] },
      ),
      get: vi.fn(async (resource: string, name?: string) => {
        if (resource === RESOURCE_MAP.AgentRun && name === 'torghut-swarm-discover-template') return template
        return null
      }),
      apply: vi.fn(async (resource: Record<string, unknown>) => {
        applied.push(resource)
        return resource
      }),
      applyStatus: vi.fn().mockResolvedValue({}),
    } as unknown as KubernetesClient

    const reconciled = await __test__.reconcileSchedulesTargetingAgentRunTemplate(kube, template, 'agents')

    expect(reconciled).toBe(1)
    const configMap = applied.find((resource) => resource.kind === 'ConfigMap') as Record<string, unknown>
    const data = configMap.data as Record<string, string>
    const payload = JSON.parse(data['run.json'] ?? '{}') as Record<string, unknown>
    expect(payload.spec).toMatchObject({
      parameters: {
        swarmMissionLedgerRef: '/workspace/.agentrun/swarm/torghut-quant-mission-ledger.md',
        swarmBusinessMetric: 'increase routeable post-cost profit evidence',
        swarmValidationContract: JSON.stringify(['prove trading evidence status']),
        swarmValueGates: JSON.stringify(['routeable_candidate_count']),
        swarmHandoffRequiredFields: JSON.stringify(['objective', 'exact_next_action']),
        swarmSourceDesign: 'docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md',
      },
      workflow: {
        steps: [
          {
            name: 'discover',
            retries: 1,
            retryBackoffSeconds: 30,
          },
        ],
      },
    })
  })

  it('resolves startup gate from feature flags with env fallback default', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousVitest = process.env.VITEST
    try {
      process.env.NODE_ENV = 'production'
      delete process.env.VITEST
      process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED = 'false'
      const resolveBooleanFeatureToggleMock = vi.mocked(resolveBooleanFeatureToggle)
      resolveBooleanFeatureToggleMock.mockResolvedValueOnce(true)

      const enabled = await __test__.shouldStartWithFeatureFlag()

      expect(enabled).toBe(true)
      expect(resolveBooleanFeatureToggleMock).toHaveBeenCalledWith({
        key: 'jangar.supporting_controller.enabled',
        keyEnvVar: 'JANGAR_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY',
        fallbackEnvVar: 'JANGAR_SUPPORTING_CONTROLLER_ENABLED',
        defaultValue: false,
      })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      if (previousVitest === undefined) {
        delete process.env.VITEST
      } else {
        process.env.VITEST = previousVitest
      }
    }
  })

  it('starts swarm watches when optional swarm CRD appears after startup', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousVitest = process.env.VITEST
    process.env.NODE_ENV = 'production'
    delete process.env.VITEST
    try {
      await startSupportingPrimitivesController()

      const watchCalls = vi.mocked(kubeWatchMocks.startResourceWatch).mock.calls as unknown[][]
      const initialSwarmWatchCalls = watchCalls.filter((call) => {
        const options = (call[0] ?? {}) as Record<string, unknown>
        return options.resource === RESOURCE_MAP.Swarm
      })
      expect(initialSwarmWatchCalls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(__test__.SWARM_CRD_REFRESH_INTERVAL_MS)

      expect(vi.mocked(kubeWatchMocks.startResourceWatch)).toHaveBeenCalledWith(
        expect.objectContaining({ resource: RESOURCE_MAP.Swarm, namespace: 'agents' }),
      )
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      if (previousVitest === undefined) {
        delete process.env.VITEST
      } else {
        process.env.VITEST = previousVitest
      }
    }
  })

  it('reconciles a valid swarm by creating stage schedules and active status', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        integrations: {
          nats: {
            url: 'nats://nats.nats.svc.cluster.local:4222',
            subjectPrefix: 'workflow',
            channel: 'general',
          },
        },
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        mission: {
          ledgerRef: '/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md',
          businessMetric: 'reduce failed AgentRuns and rollout latency',
          validationContract: ['produce a tested PR', 'verify rollout health'],
          valueGates: ['failed_agentrun_rate', 'pr_to_rollout_latency'],
          handoffRequiredFields: ['objective', 'commands_and_exit_codes', 'exact_next_action'],
          sourceDesign: 'docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    for (const call of apply.mock.calls) {
      const payload = call[0] as Record<string, unknown>
      expect(payload.kind).toBe('Schedule')
      expect(payload.apiVersion).toBe('schedules.proompteng.ai/v1alpha1')
      const labels =
        payload?.metadata && typeof payload.metadata === 'object'
          ? (payload.metadata as Record<string, unknown>).labels
          : undefined
      expect(labels).toBeTruthy()
      expect(labels).toMatchObject({
        'swarm.proompteng.ai/uid': 'swarm-uid',
      })
      const labelsRecord = (labels ?? {}) as Record<string, unknown>
      expect(typeof labelsRecord['swarm.proompteng.ai/worker-id']).toBe('string')

      const annotations =
        payload?.metadata && typeof payload.metadata === 'object'
          ? (payload.metadata as Record<string, unknown>).annotations
          : undefined
      expect(annotations).toMatchObject({
        'swarm.proompteng.ai/nats-url': 'nats://nats.nats.svc.cluster.local:4222',
        'swarm.proompteng.ai/nats-subject-prefix': 'workflow',
        'swarm.proompteng.ai/nats-channel': 'general',
        'swarm.proompteng.ai/mission-ledger-ref': '/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md',
        'swarm.proompteng.ai/business-metric': 'reduce failed AgentRuns and rollout latency',
        'swarm.proompteng.ai/validation-contract': JSON.stringify(['produce a tested PR', 'verify rollout health']),
        'swarm.proompteng.ai/value-gates': JSON.stringify(['failed_agentrun_rate', 'pr_to_rollout_latency']),
        'swarm.proompteng.ai/handoff-fields': JSON.stringify([
          'objective',
          'commands_and_exit_codes',
          'exact_next_action',
        ]),
        'swarm.proompteng.ai/source-design': 'docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md',
      })
      expect(typeof (annotations as Record<string, unknown>)['swarm.proompteng.ai/worker-id']).toBe('string')
      expect(typeof (annotations as Record<string, unknown>)['swarm.proompteng.ai/agent-identity']).toBe('string')
    }
    expect(deleteFn).not.toHaveBeenCalled()
    expect(applyStatus).toHaveBeenCalledTimes(1)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Active')
    expect(status.activeMissions).toBe(0)
    expect(status.mission).toMatchObject({
      ledgerRef: '/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md',
      businessMetric: 'reduce failed AgentRuns and rollout latency',
      validationContract: ['produce a tested PR', 'verify rollout health'],
      valueGates: ['failed_agentrun_rate', 'pr_to_rollout_latency'],
    })
    expect(status.stageStates).toBeTruthy()
  })

  it('does not derive NATS url from owner channel transport-like values', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'http://example.invalid' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        mission: {
          ledgerRef: '/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md',
          businessMetric: 'reduce failed AgentRuns',
          validationContract: ['dispatch requirements only when business value is named'],
          valueGates: ['failed_agentrun_rate'],
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const schedulePayload = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.kind === 'Schedule') as { metadata?: Record<string, unknown> } | undefined
    expect(schedulePayload).toBeDefined()
    const annotations = (schedulePayload?.metadata?.annotations ?? {}) as Record<string, string>
    expect(annotations['swarm.proompteng.ai/nats-url']).toBe('nats://nats.nats.svc.cluster.local:4222')
  })

  it('keeps swarm ready when schedule timestamps are stale but stage runs succeeded recently', async () => {
    vi.setSystemTime(new Date('2026-01-20T03:00:00Z'))

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const deleteFn = vi.fn().mockResolvedValue(null)
    const recentSuccessAt = '2026-01-20T02:30:00Z'
    const staleScheduleRunAt = '2026-01-20T00:00:00Z'
    const stageRuns = ['discover', 'plan', 'implement', 'verify'].map((stage) => ({
      kind: 'AgentRun',
      metadata: {
        name: `jangar-control-plane-${stage}-recent-success`,
        namespace: 'agents',
        labels: {
          'swarm.proompteng.ai/name': 'jangar-control-plane',
          'swarm.proompteng.ai/stage': stage,
          'swarm.proompteng.ai/uid': 'swarm-uid',
        },
        creationTimestamp: recentSuccessAt,
      },
      status: {
        phase: 'Succeeded',
        startedAt: recentSuccessAt,
        finishedAt: recentSuccessAt,
      },
    }))
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: staleScheduleRunAt } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-sample', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {},
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) return { items: stageRuns }
      return { items: [] }
    })
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '1h',
          planEvery: '1h',
          implementEvery: '1h',
          verifyEvery: '1h',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        mission: {
          ledgerRef: '/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md',
          businessMetric: 'reduce failed AgentRuns',
          validationContract: ['dispatch requirements only when business value is named'],
          valueGates: ['failed_agentrun_rate'],
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(applyStatus).toHaveBeenCalledTimes(1)
    const status = (applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const stageStates = (status.stageStates ?? {}) as Record<string, Record<string, unknown>>
    for (const stage of ['discover', 'plan', 'implement', 'verify']) {
      expect(stageStates[stage]?.fresh).toBe(true)
      expect(stageStates[stage]?.healthy).toBe(true)
      expect(stageStates[stage]?.recentSuccessAt).toBe(new Date(recentSuccessAt).toISOString())
    }

    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const ready = conditions.find((condition) => condition.type === 'Ready')
    const degraded = conditions.find((condition) => condition.type === 'Degraded')
    expect(ready).toMatchObject({ status: 'True', reason: 'Active', message: 'swarm active' })
    expect(degraded).toMatchObject({
      status: 'False',
      reason: 'Healthy',
      message: 'all stage and requirement health checks passing',
    })
  })

  it('dispatches NATS requirement signals into implement runs', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
            secrets: ['keep-me'],
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-1',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                description: 'Raise risk budget guardrails for market-open volatility',
                payload: {
                  priority: 'high',
                  acceptance: 'deploy and verify policy',
                  context: {
                    source: 'torghut-quant',
                    deadline: '2026-01-25T00:00:00Z',
                  },
                },
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        mission: {
          ledgerRef: '/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md',
          businessMetric: 'reduce failed AgentRuns',
          validationContract: ['dispatch requirements only when business value is named'],
          valueGates: ['failed_agentrun_rate'],
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    const runLabels = (requirementRun.metadata.labels ?? {}) as Record<string, string>
    expect(runLabels['swarm.proompteng.ai/requirement-channel']).toBe('nats')
    expect(runLabels['swarm.proompteng.ai/from']).toBe('torghut-quant')
    expect(runLabels['swarm.proompteng.ai/to']).toBe('jangar-control-plane')
    expect(runLabels['swarm.proompteng.ai/worker-id']).toMatch(/^worker-/)
    expect(runLabels['swarm.proompteng.ai/requirement-attempt']).toBe('1')

    const parameters = (requirementRun.spec.parameters ?? {}) as Record<string, string>
    expect(parameters.staticKey).toBe('static-value')
    expect(parameters.swarmRequirementSignal).toBe('torghut-risk-handoff-1')
    expect(parameters.swarmRequirementChannel).toBe('workflow.general.requirement')
    expect(parameters.swarmRequirementSource).toBe('torghut-quant')
    expect(parameters.swarmRequirementTarget).toBe('jangar-control-plane')
    expect(parameters.swarmRequirementDescription).toBe('Raise risk budget guardrails for market-open volatility')
    const payload = parameters.swarmRequirementPayload ? JSON.parse(parameters.swarmRequirementPayload) : null
    expect(payload).toEqual({
      priority: 'high',
      acceptance: 'deploy and verify policy',
      context: {
        source: 'torghut-quant',
        deadline: '2026-01-25T00:00:00Z',
      },
    })
    expect(parameters.objective).toBe(
      'Raise risk budget guardrails for market-open volatility\n\nacceptance: deploy and verify policy',
    )
    expect(parameters.swarmAgentWorkerId).toMatch(/^worker-/)
    expect(parameters.swarmAgentIdentity).toBe('elise-novak-jangar-engineer')
    expect(parameters.swarmAgentRole).toBe('engineer')
    expect(parameters.swarmHumanName).toBe('Elise Novak')
    expect(parameters.natsUrl).toBe('nats://nats.nats.svc.cluster.local:4222')
    expect(parameters.natsSubjectPrefix).toBe('workflow')
    expect(parameters.natsChannel).toBe('general')
    expect(parameters.swarmMissionLedgerRef).toBe('/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md')
    expect(parameters.swarmBusinessMetric).toBe('reduce failed AgentRuns')
    expect(parameters.swarmValidationContract).toBe(
      JSON.stringify(['dispatch requirements only when business value is named']),
    )
    expect(parameters.swarmValueGates).toBe(JSON.stringify(['failed_agentrun_rate']))
    expect(parameters.swarmSourceDesign).toBe('docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md')
    expect(parameters.swarmAgentTokenKey).toBeUndefined()
    expect(parameters.swarmAgentExpectedActorIdKey).toBeUndefined()
    const runSecrets = Array.isArray(requirementRun.spec.secrets) ? (requirementRun.spec.secrets as string[]) : []
    expect(runSecrets).toContain('keep-me')
    expect(runSecrets).toHaveLength(1)
    expect((requirementRun.spec.workload as { image?: string } | undefined)?.image).toContain(TEST_RUNNER_IMAGE)

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.pending).toBe(1)
    expect(requirements.dispatched).toBe(1)
    expect(requirements.invalidChannel).toBe(0)
    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const bridge = conditions.find((condition) => condition.type === 'RequirementsBridge')
    expect(bridge?.status).toBe('True')
  })

  it('pauses requirement dispatch when AgentRun ingestion is degraded', async () => {
    vi.spyOn(agentsControllerModule, 'assessAgentRunIngestion').mockReturnValue({
      namespace: 'agents',
      status: 'degraded',
      message: 'no AgentRun watch events observed since controller start while untouched runs exist',
      dispatchPaused: true,
      lastWatchEventAt: null,
      lastResyncAt: '2026-01-20T00:00:00Z',
      untouchedRunCount: 2,
      oldestUntouchedAgeSeconds: 180,
    })

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-paused',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                description: 'Pause dispatch until AgentRun ingestion recovers',
                payload: { priority: 'critical' },
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(0)

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.pending).toBe(1)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.blocked).toBe(1)
    expect(requirements.paused).toBe(true)
    expect(requirements.pauseReason).toBe('AgentRunIngestionDegraded')
    expect(String(requirements.pauseMessage)).toContain('AgentRun')

    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const bridge = conditions.find((condition) => condition.type === 'RequirementsBridge') as
      | Record<string, unknown>
      | undefined
    expect(bridge?.status).toBe('False')
    expect(bridge?.reason).toBe('AgentRunIngestionDegraded')
  })

  it('blocks stage schedules when the stage admission passport is not allowed', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildAdmissionSnapshot({
        swarm_plan: {
          decision: 'block',
          reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
        },
      }),
    )

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-sample', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async () => ({ items: [] }))
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const schedulePayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'Schedule')
    expect(schedulePayloads).toHaveLength(2)
    expect(schedulePayloads.map((payload) => (payload.metadata as Record<string, unknown>).labels)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ 'swarm.proompteng.ai/stage': 'implement' }),
        expect.objectContaining({ 'swarm.proompteng.ai/stage': 'verify' }),
      ]),
    )
    expect(deleteFn).toHaveBeenCalledWith(RESOURCE_MAP.Schedule, expect.stringContaining('discover-sched'), 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith(RESOURCE_MAP.Schedule, expect.stringContaining('plan-sched'), 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith('configmap', expect.stringContaining('discover-sched-template'), 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith('cronjob', expect.stringContaining('discover-sched-cron'), 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith('configmap', expect.stringContaining('plan-sched-template'), 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith('cronjob', expect.stringContaining('plan-sched-cron'), 'agents', {
      wait: false,
    })

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const stageStates = (status.stageStates ?? {}) as Record<string, Record<string, unknown>>
    expect(stageStates.discover?.phase).toBe('AdmissionBlocked')
    expect(stageStates.plan?.phase).toBe('AdmissionBlocked')
    expect((stageStates.plan?.admission as Record<string, unknown> | undefined)?.passportId).toBe(
      'passport:swarm_plan:test',
    )
    expect((stageStates.plan?.admission as Record<string, unknown> | undefined)?.decision).toBe('block')
  })

  it('blocks stage schedules when the stage recovery warrant is not sealed', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildAdmissionSnapshot(
        {},
        {
          plan: {
            status: 'active',
            sealed_at: null,
            reason_codes: ['runtime_proof_degraded:collaboration'],
          },
        },
      ),
    )

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-sample', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async () => ({ items: [] }))
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const schedulePayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'Schedule')
    const scheduleStages = schedulePayloads.map((payload) =>
      String(
        ((payload.metadata as Record<string, unknown>).labels as Record<string, unknown>)['swarm.proompteng.ai/stage'],
      ),
    )
    expect(scheduleStages).toEqual(expect.arrayContaining(['discover', 'implement', 'verify']))
    expect(scheduleStages).not.toContain('plan')
    expect(deleteFn).toHaveBeenCalledWith(RESOURCE_MAP.Schedule, expect.stringContaining('plan-sched'), 'agents', {
      wait: false,
    })

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const stageStates = (status.stageStates ?? {}) as Record<string, Record<string, unknown>>
    const planAdmission = stageStates.plan?.admission as Record<string, unknown> | undefined
    expect(stageStates.plan?.phase).toBe('AdmissionBlocked')
    expect(stageStates.plan?.reason).toBe('RuntimeProofSurfaceBlocked')
    expect(String(stageStates.plan?.message)).toContain('recovery warrant recovery-warrant:plan:test')
    expect(planAdmission?.recoveryWarrantId).toBe('recovery-warrant:plan:test')
    expect(planAdmission?.recoveryWarrantStatus).toBe('active')
  })

  it('keeps passport-only stage admission available when runtime proof enforcement is disabled', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    process.env.JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT = '0'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildAdmissionSnapshot(
        {},
        {
          plan: {
            status: 'broken',
            sealed_at: null,
            reason_codes: ['runtime_proof_missing:helper_asset'],
          },
        },
      ),
    )

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-sample', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async () => ({ items: [] }))
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const schedulePayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'Schedule')
    const scheduleStages = schedulePayloads.map((payload) =>
      String(
        ((payload.metadata as Record<string, unknown>).labels as Record<string, unknown>)['swarm.proompteng.ai/stage'],
      ),
    )
    expect(scheduleStages).toEqual(expect.arrayContaining(['discover', 'plan', 'implement', 'verify']))

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const stageStates = (status.stageStates ?? {}) as Record<string, Record<string, unknown>>
    const planAdmission = stageStates.plan?.admission as Record<string, unknown> | undefined
    expect(planAdmission?.admitted).toBe(true)
    expect(planAdmission?.proofEnforced).toBe(false)
    expect(planAdmission?.recoveryWarrantStatus).toBe('broken')
  })

  it('blocks requirement dispatch when the implement admission passport is not allowed', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildAdmissionSnapshot({
        swarm_implement: {
          decision: 'block',
          reason_codes: ['runtime_kit_component_missing:nats_cli'],
        },
      }),
    )

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              apiVersion: 'signals.proompteng.ai/v1alpha1',
              kind: 'Signal',
              metadata: {
                name: 'torghut-risk-handoff-admission-blocked',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                payload: { priority: 'critical' },
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(0)

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.pending).toBe(1)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.blocked).toBe(1)
    expect(requirements.admissionBlocked).toBe(1)
    expect(requirements.rejected).toBe(1)
    expect((requirements.admission as Record<string, unknown> | undefined)?.passportId).toBe(
      'passport:swarm_implement:test',
    )
    expect((requirements.admission as Record<string, unknown> | undefined)?.decision).toBe('block')

    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const bridge = conditions.find((condition) => condition.type === 'RequirementsBridge') as
      | Record<string, unknown>
      | undefined
    expect(bridge?.status).toBe('False')
    expect(bridge?.reason).toBe('RuntimeAdmissionBlocked')
    expect(String(bridge?.message)).toContain('runtime_kit_component_missing:nats_cli')

    const signalStatusCall = applyStatus.mock.calls.find((call) => {
      const payload = call[0] as Record<string, unknown>
      return payload.kind === 'Signal'
    })
    const signalStatus = (signalStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(signalStatus.phase).toBe('Rejected')
    const signalReady = (Array.isArray(signalStatus.conditions) ? signalStatus.conditions : []).find(
      (condition) => condition.type === 'Ready',
    )
    expect(signalReady?.reason).toBe('RuntimeAdmissionBlocked')
    expect(String(signalReady?.message)).toContain('passport:swarm_implement:test')
  })

  it('blocks requirement dispatch when the implement recovery warrant is broken', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildAdmissionSnapshot(
        {},
        {
          implement: {
            status: 'broken',
            sealed_at: null,
            reason_codes: ['runtime_proof_missing:helper_asset'],
          },
        },
        {
          implement: {
            status: 'missing',
            reason_codes: ['runtime_proof_missing:helper_asset'],
          },
        },
      ),
    )

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              apiVersion: 'signals.proompteng.ai/v1alpha1',
              kind: 'Signal',
              metadata: {
                name: 'torghut-risk-handoff-proof-broken',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                payload: { priority: 'critical' },
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(0)

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    const requirementAdmission = requirements.admission as Record<string, unknown> | undefined
    expect(requirements.pending).toBe(1)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.blocked).toBe(1)
    expect(requirements.admissionBlocked).toBe(1)
    expect(requirements.rejected).toBe(1)
    expect(requirementAdmission?.passportId).toBe('passport:swarm_implement:test')
    expect(requirementAdmission?.recoveryWarrantId).toBe('recovery-warrant:implement:test')
    expect(requirementAdmission?.recoveryWarrantStatus).toBe('broken')

    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const bridge = conditions.find((condition) => condition.type === 'RequirementsBridge') as
      | Record<string, unknown>
      | undefined
    expect(bridge?.status).toBe('False')
    expect(bridge?.reason).toBe('RuntimeProofSurfaceBlocked')
    expect(String(bridge?.message)).toContain('runtime_proof_missing:helper_asset')

    const signalStatusCall = applyStatus.mock.calls.find((call) => {
      const payload = call[0] as Record<string, unknown>
      return payload.kind === 'Signal'
    })
    const signalStatus = (signalStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(signalStatus.phase).toBe('Rejected')
    const signalReady = (Array.isArray(signalStatus.conditions) ? signalStatus.conditions : []).find(
      (condition) => condition.type === 'Ready',
    )
    expect(signalReady?.reason).toBe('RuntimeProofSurfaceBlocked')
    expect(String(signalReady?.message)).toContain('recovery-warrant:implement:test')
  })

  it('keeps requirement signals pending when the implement admission passport is on hold', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildAdmissionSnapshot({
        swarm_implement: {
          decision: 'hold',
          reason_codes: ['runtime_kit_degraded:collaboration'],
        },
      }),
    )

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              apiVersion: 'signals.proompteng.ai/v1alpha1',
              kind: 'Signal',
              metadata: {
                name: 'torghut-risk-handoff-admission-hold',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                payload: { priority: 'critical' },
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(0)

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.pending).toBe(1)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.blocked).toBe(1)
    expect(requirements.admissionBlocked).toBe(1)
    expect(requirements.rejected).toBe(0)
    expect((requirements.admission as Record<string, unknown> | undefined)?.decision).toBe('hold')

    const signalStatusCall = applyStatus.mock.calls.find((call) => {
      const payload = call[0] as Record<string, unknown>
      return payload.kind === 'Signal'
    })
    expect(signalStatusCall).toBeUndefined()
  })

  it('fails closed for stage schedules and requirement dispatch when admission snapshots are unavailable', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockImplementation(() => {
      throw new Error('runtime admission database unavailable')
    })

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-admission-unavailable',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                payload: { priority: 'critical' },
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const appliedKinds = apply.mock.calls.map((call) => (call[0] as Record<string, unknown>).kind)
    expect(appliedKinds).not.toContain('Schedule')
    expect(appliedKinds).not.toContain('AgentRun')
    expect(deleteFn).toHaveBeenCalledWith(RESOURCE_MAP.Schedule, expect.stringContaining('discover-sched'), 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith(RESOURCE_MAP.Schedule, expect.stringContaining('plan-sched'), 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith(RESOURCE_MAP.Schedule, expect.stringContaining('implement-sched'), 'agents', {
      wait: false,
    })
    expect(deleteFn).toHaveBeenCalledWith(RESOURCE_MAP.Schedule, expect.stringContaining('verify-sched'), 'agents', {
      wait: false,
    })
    for (const stage of ['discover', 'plan', 'implement', 'verify']) {
      expect(deleteFn).toHaveBeenCalledWith('configmap', expect.stringContaining(`${stage}-sched-template`), 'agents', {
        wait: false,
      })
      expect(deleteFn).toHaveBeenCalledWith('cronjob', expect.stringContaining(`${stage}-sched-cron`), 'agents', {
        wait: false,
      })
    }

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const stageStates = (status.stageStates ?? {}) as Record<string, Record<string, unknown>>
    expect(stageStates.discover?.phase).toBe('AdmissionBlocked')
    expect(stageStates.plan?.phase).toBe('AdmissionBlocked')
    expect(stageStates.implement?.phase).toBe('AdmissionBlocked')
    expect(stageStates.verify?.phase).toBe('AdmissionBlocked')
    expect(stageStates.implement?.reason).toBe('RuntimeAdmissionUnavailable')

    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.pending).toBe(1)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.blocked).toBe(1)
    expect(requirements.admissionBlocked).toBe(1)
    expect((requirements.admission as Record<string, unknown> | undefined)?.reason).toBe('RuntimeAdmissionUnavailable')

    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const bridge = conditions.find((condition) => condition.type === 'RequirementsBridge') as
      | Record<string, unknown>
      | undefined
    expect(bridge?.status).toBe('False')
    expect(bridge?.reason).toBe('RuntimeAdmissionUnavailable')
    expect(String(bridge?.message)).toContain('runtime admission database unavailable')
  })

  it('annotates admitted requirement runs with the implement admission passport', async () => {
    process.env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT = '1'

    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-admitted',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                payload: { priority: 'critical' },
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRun = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .find((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      }) as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> } | undefined

    expect(requirementRun).toBeTruthy()
    expect(requirementRun?.metadata?.annotations).toMatchObject({
      'swarm.proompteng.ai/admission-passport-id': 'passport:swarm_implement:test',
      'swarm.proompteng.ai/admission-decision': 'allow',
      'swarm.proompteng.ai/runtime-kit-set-digest': 'runtime-digest:swarm_implement',
      'swarm.proompteng.ai/recovery-warrant-id': 'recovery-warrant:implement:test',
      'swarm.proompteng.ai/recovery-warrant-status': 'sealed',
      'swarm.proompteng.ai/required-proof-cells': 'runtime-proof-cell:implement:test',
    })
    expect(requirementRun?.spec?.parameters).toMatchObject({
      swarmAdmissionPassportId: 'passport:swarm_implement:test',
      swarmAdmissionDecision: 'allow',
      swarmRecoveryCaseSetDigest: 'recovery-digest-test',
      swarmRuntimeKitSetDigest: 'runtime-digest:swarm_implement',
      swarmRequiredRuntimeKits: 'runtime-kit:swarm_implement:test',
      swarmAdmissionProducerRevision: 'test-producer-revision',
      swarmRecoveryWarrantId: 'recovery-warrant:implement:test',
      swarmRecoveryWarrantStatus: 'sealed',
      swarmRequiredProofCells: 'runtime-proof-cell:implement:test',
    })
  })

  it('dispatches higher-priority requirement signals before lower-priority signals', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
            secrets: ['keep-me'],
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-low-priority',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                description: 'Low priority scope',
                payload: {
                  priority: 'low',
                },
              },
            },
            {
              metadata: {
                name: 'torghut-critical-priority',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:10:00Z',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                description: 'Critical priority scope',
                payload: {
                  priority: 'critical',
                },
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(2)
    const firstParameters = (requirementRunPayloads[0]?.spec as Record<string, unknown> | undefined)?.parameters as
      | Record<string, string>
      | undefined
    const secondParameters = (requirementRunPayloads[1]?.spec as Record<string, unknown> | undefined)?.parameters as
      | Record<string, string>
      | undefined
    expect(firstParameters?.swarmRequirementSignal).toBe('torghut-critical-priority')
    expect(secondParameters?.swarmRequirementSignal).toBe('torghut-low-priority')
  })

  it('uses requirement payload as primary objective when description is missing', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
          },
        }
      }
      return null
    })
    const payloadForObjective = {
      priority: 'critical',
      constraints: ['do not touch auth'],
      acceptance: ['add guardrail', 'run chaos test'],
    }
    const payloadForObjectiveString = JSON.stringify(payloadForObjective)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              apiVersion: 'signals.proompteng.ai/v1alpha1',
              kind: 'Signal',
              metadata: {
                name: 'torghut-risk-handoff-2',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                payload: payloadForObjective,
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    const parameters = (requirementRun.spec.parameters ?? {}) as Record<string, string>
    expect(parameters.swarmRequirementSignal).toBe('torghut-risk-handoff-2')
    expect(parameters.swarmRequirementDescription).toBeUndefined()
    expect(parameters.swarmRequirementPayload).toBe(payloadForObjectiveString)
    expect(parameters.objective).toBe('acceptance: add guardrail, run chaos test')
    expect(parameters.swarmRequirementPayloadBytes).toBe('107')
  })

  it('uses mission from payload as objective when objective and acceptance are missing', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
          },
        }
      }
      return null
    })
    const payloadForObjective = {
      mission: 'stabilize requirement handoff latency',
      scope: 'handoff',
      acceptanceCriteria: ['publish handoff artifacts'],
    }
    const payloadForObjectiveString = JSON.stringify(payloadForObjective)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-mission',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                payload: payloadForObjective,
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      spec: Record<string, unknown>
    }
    const parameters = (requirementRun.spec.parameters ?? {}) as Record<string, string>
    expect(parameters.swarmRequirementSignal).toBe('torghut-risk-handoff-mission')
    expect(parameters.swarmRequirementDescription).toBeUndefined()
    expect(parameters.swarmRequirementPayload).toBe(payloadForObjectiveString)
    expect(parameters.objective).toBe('mission: stabilize requirement handoff latency')
    expect(parameters.swarmRequirementPayloadBytes).toBe(
      String(new TextEncoder().encode(payloadForObjectiveString).length),
    )
  })

  it('extracts objective from payload object when present', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
          },
        }
      }
      return null
    })
    const payloadForObjective = {
      objective: 'Align platform handoff policy and rollback checks',
      acceptance: ['add feature gate', 'run canary check'],
      scope: 'reliability',
    }
    const payloadForObjectiveString = JSON.stringify(payloadForObjective)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-3',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                payload: payloadForObjective,
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    const parameters = (requirementRun.spec.parameters ?? {}) as Record<string, string>
    expect(parameters.swarmRequirementSignal).toBe('torghut-risk-handoff-3')
    expect(parameters.swarmRequirementDescription).toBeUndefined()
    expect(parameters.swarmRequirementPayload).toBe(payloadForObjectiveString)
    expect(parameters.objective).toBe(payloadForObjective.objective)
    expect(parameters.swarmRequirementPayloadBytes).toBe(
      String(new TextEncoder().encode(payloadForObjectiveString).length),
    )
  })

  it('uses objective payload truncation metadata when payload exceeds transfer cap', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
          },
        }
      }
      return null
    })
    const largePayload = { riskMode: 'critical', details: 'x'.repeat(18_000) }
    const largePayloadString = JSON.stringify(largePayload)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-4',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
                description: 'Long payload truncation validation run',
                payload: largePayload,
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const truncatedRun = requirementRunPayloads.find((requirement) => {
      const spec = (requirement as { spec: Record<string, unknown> }).spec
      const payload = (spec.parameters as Record<string, string> | undefined)?.swarmRequirementPayload
      return typeof payload === 'string' && payload.length === 16_384
    })
    expect(truncatedRun).toBeTruthy()
    const parameters = ((truncatedRun as { spec: Record<string, unknown> }).spec.parameters ?? {}) as Record<
      string,
      string
    >
    const payload = parameters.swarmRequirementPayload
    expect(parameters.swarmRequirementPayloadBytes).toBeDefined()
    expect(Number(parameters.swarmRequirementPayloadBytes)).toBeGreaterThan(16_384)
    expect(parameters.swarmRequirementPayloadTruncated).toBe('true')
    expect(payload.length).toBe(16_384)
    expect(payload).toBe(largePayloadString.slice(0, 16_384))
  })

  it('rejects non-NATS requirement channels for cross-swarm implementation', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              apiVersion: 'signals.proompteng.ai/v1alpha1',
              kind: 'Signal',
              metadata: {
                name: 'torghut-risk-handoff-2',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'slack://swarm-bridge/TOR-456',
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.pending).toBe(0)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.invalidChannel).toBe(1)
    expect(requirements.rejected).toBe(1)
    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const bridge = conditions.find((condition) => condition.type === 'RequirementsBridge')
    expect(bridge?.status).toBe('True')
    expect((bridge as { reason?: string } | undefined)?.reason).toBe('InvalidRequirementChannelRejected')

    const signalStatusCall = applyStatus.mock.calls.find((call) => {
      const payload = call[0] as Record<string, unknown>
      return payload.kind === 'Signal'
    })
    const signalStatus = (signalStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(signalStatus.phase).toBe('Rejected')
  })

  it('does not count terminal rejected requirement signals as pending debt', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              apiVersion: 'signals.proompteng.ai/v1alpha1',
              kind: 'Signal',
              metadata: {
                name: 'torghut-risk-handoff-rejected',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'slack://swarm-bridge/TOR-456',
              },
              status: {
                phase: 'Rejected',
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.pending).toBe(0)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.invalidChannel).toBe(0)
    expect(requirements.rejected).toBe(0)
  })

  it('does not re-dispatch requirement signals that already completed', async () => {
    const requirementSignalName = 'torghut-risk-handoff-3'
    const requirementId = requirementIdForSignal('agents', requirementSignalName)
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              kind: 'AgentRun',
              metadata: {
                name: 'completed-requirement-run',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'jangar-control-plane',
                  'swarm.proompteng.ai/stage': 'implement',
                  'swarm.proompteng.ai/requirement-id': requirementId,
                },
              },
              status: { phase: 'Succeeded' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: requirementSignalName,
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.completed).toBe(1)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.pending).toBe(0)
  })

  it('re-dispatches requirement signals after failed attempts until max retry count', async () => {
    const requirementSignalName = 'torghut-risk-handoff-4'
    const requirementId = requirementIdForSignal('agents', requirementSignalName)
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              kind: 'AgentRun',
              metadata: {
                name: 'failed-requirement-run',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/name': 'jangar-control-plane',
                  'swarm.proompteng.ai/stage': 'implement',
                  'swarm.proompteng.ai/requirement-id': requirementId,
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: requirementSignalName,
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'workflow.general.requirement',
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    const runLabels = (requirementRun.metadata.labels ?? {}) as Record<string, string>
    expect(runLabels['swarm.proompteng.ai/requirement-attempt']).toBe('2')
    expect((requirementRun.spec.idempotencyKey as string) ?? '').toContain('-attempt-2')
  })

  it('normalizes long swarm names into valid label values for schedules', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const longName = `${'a'.repeat(62)}-b`
    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: longName, namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    for (const call of apply.mock.calls) {
      const payload = call[0] as Record<string, unknown>
      const labels =
        payload?.metadata && typeof payload.metadata === 'object'
          ? (payload.metadata as Record<string, unknown>).labels
          : undefined
      expect(labels).toBeTruthy()
      expect(labels).toMatchObject({
        'swarm.proompteng.ai/uid': 'swarm-uid',
      })
      const labelsRecord = (labels ?? {}) as Record<string, unknown>
      const swarmLabel = labelsRecord['swarm.proompteng.ai/name']
      expect(typeof swarmLabel).toBe('string')
      const normalizedLabel = String(swarmLabel)
      expect(normalizedLabel.length).toBeLessThanOrEqual(63)
      expect(normalizedLabel).toBe('a'.repeat(62))
      expect(normalizedLabel).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
    }
  })

  it('creates unique schedules for each stage even when swarm name is long', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const longName = `${'a'.repeat(90)}`
    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: longName, namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    const scheduleNames = apply.mock.calls.map((call) => {
      const payload = call[0] as Record<string, unknown>
      return asString(payload?.metadata ? (payload.metadata as Record<string, unknown>).name : undefined)
    })
    const uniqueNames = new Set(scheduleNames)
    expect(scheduleNames.filter((name): name is string => typeof name === 'string')).toHaveLength(4)
    expect(uniqueNames.size).toBe(4)
  })

  it('freezes swarm when implement stage has consecutive failures over threshold', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              metadata: {
                name: 'run-2',
                creationTimestamp: '2026-01-20T00:01:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
            {
              metadata: {
                name: 'run-1',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(12)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Frozen')
    expect(status.freeze).toBeTruthy()
  })

  it('keeps schedules active during stage-staleness recovery freezes', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
      status: {
        lastVerifyAt: '2026-01-19T23:50:00Z',
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    expect(deleteFn).not.toHaveBeenCalled()
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Frozen')
    expect(status.freeze).toMatchObject({
      reason: 'StageStaleness',
    })
  })

  it('includes nested workflow failure detail in freeze evidence when top-level status is empty', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              metadata: {
                name: 'run-2',
                creationTimestamp: '2026-01-20T00:01:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: {
                phase: 'Failed',
                workflow: {
                  steps: [
                    {
                      name: 'deploy-step',
                      phase: 'Failed',
                      message: 'workflow step deploy-step: container exited with code 17',
                    },
                  ],
                },
              },
            },
            {
              metadata: {
                name: 'run-1',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: {
                phase: 'Failed',
                workflow: {
                  steps: [
                    {
                      name: 'deploy-step',
                      phase: 'Failed',
                      message: 'workflow step deploy-step: container exited with code 17',
                    },
                  ],
                },
              },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.freeze).toMatchObject({
      reason: 'ConsecutiveFailures',
      evidence: {
        triggeringRuns: expect.arrayContaining([
          expect.objectContaining({ reason: 'workflow step deploy-step: container exited with code 17' }),
        ]),
      },
    })
  })

  it('freezes when consecutive timed-out implement failures remain active', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string, name: string) => {
      if (resource === 'job' && (name === 'timeout-job-1' || name === 'timeout-job-2')) {
        return {
          metadata: { name, namespace: 'agents' },
          status: {
            succeeded: 1,
            startTime: '2026-01-20T00:00:00Z',
            completionTime: '2026-01-20T00:10:00Z',
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              metadata: {
                name: 'run-2',
                creationTimestamp: '2026-01-20T00:01:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: {
                phase: 'Failed',
                runtimeRef: { type: 'workflow', name: 'timeout-job-2', namespace: 'agents' },
                conditions: [{ type: 'Failed', status: 'True', reason: 'WorkflowStepTimedOut' }],
              },
            },
            {
              metadata: {
                name: 'run-1',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: {
                phase: 'Failed',
                runtimeRef: { type: 'workflow', name: 'timeout-job-1', namespace: 'agents' },
                conditions: [{ type: 'Failed', status: 'True', reason: 'WorkflowStepTimedOut' }],
              },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(12)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Frozen')
    expect(status.freeze).toMatchObject({
      reason: 'ConsecutiveFailures',
    })
  })

  it('counts implement failures from configured target namespaces when deciding freeze', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const list = vi.fn(async (_resource: string, namespace: string) => {
      if (namespace === 'agents-implement') {
        return {
          items: [
            {
              metadata: {
                name: 'run-2',
                creationTimestamp: '2026-01-20T00:01:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
            {
              metadata: {
                name: 'run-1',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample', namespace: 'agents-implement' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample', namespace: 'agents-implement' } },
          implement: {
            targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample', namespace: 'agents-implement' },
          },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample', namespace: 'agents-implement' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(list).toHaveBeenCalledWith(
      RESOURCE_MAP.AgentRun,
      'agents-implement',
      'swarm.proompteng.ai/name=torghut-quant,swarm.proompteng.ai/uid=swarm-uid',
    )
    expect(list).toHaveBeenCalledWith(
      RESOURCE_MAP.OrchestrationRun,
      'agents-implement',
      'swarm.proompteng.ai/name=torghut-quant,swarm.proompteng.ai/uid=swarm-uid',
    )
    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(12)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Frozen')
    expect(status.freeze).toBeTruthy()
  })

  it('does not deduplicate runs that share name across different run kinds', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              kind: 'AgentRun',
              metadata: {
                name: 'shared-run',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:01:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.OrchestrationRun) {
        return {
          items: [
            {
              kind: 'OrchestrationRun',
              metadata: {
                name: 'shared-run',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(12)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Frozen')
    expect(status.freeze).toBeTruthy()
  })

  it('resumes schedules when stale stage evidence only predates freeze expiry', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              metadata: {
                name: 'old-run-2',
                creationTimestamp: '2026-01-19T22:59:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
            {
              metadata: {
                name: 'old-run-1',
                creationTimestamp: '2026-01-19T22:58:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
      status: {
        freeze: {
          reason: 'ConsecutiveFailures',
          until: '2026-01-19T23:00:00Z',
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    expect(deleteFn).not.toHaveBeenCalled()
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Active')
    expect(status.freeze).toMatchObject({
      reason: 'NotFrozen',
      evidence: {
        stageStaleness: [],
        triggers: [],
      },
    })
  })

  it('reconciles again after freeze expiry to resume schedules automatically', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
      status: {
        freeze: {
          reason: 'ConsecutiveFailures',
          until: '2026-01-20T00:00:05Z',
        },
      },
    }
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Swarm) return swarm
      if (resource === RESOURCE_MAP.Schedule) {
        return {
          status: {
            phase: 'Active',
            lastRunTime: '2026-01-20T00:00:05Z',
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).not.toHaveBeenCalled()
    const initialStatusCall = applyStatus.mock.calls[0]
    const initialStatus = (initialStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(initialStatus.phase).toBe('Frozen')

    await vi.advanceTimersByTimeAsync(5000)

    expect(get).toHaveBeenCalledWith(RESOURCE_MAP.Swarm, 'torghut-quant', 'agents')
    expect(apply).toHaveBeenCalledTimes(4)
    const finalStatusCall = applyStatus.mock.calls.at(-1)
    const finalStatus = (finalStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(finalStatus.phase).toBe('Active')
    expect(finalStatus.freeze).toMatchObject({
      reason: 'NotFrozen',
      threshold: 2,
      durationMs: 60 * 60 * 1000,
      evidence: {
        triggeringRuns: [],
        stageStaleness: [],
        triggers: [],
      },
    })
    expect(finalStatus.freeze).toHaveProperty('until')
    expect(finalStatus.freeze).toHaveProperty('enteredAt')
  })

  it('chunks unfreeze timers so long freeze durations wait the full expiry time', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const longFreezeMs = 2_500_000_000
    const freezeUntil = new Date(Date.now() + longFreezeMs).toISOString()
    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
      status: {
        freeze: {
          reason: 'ConsecutiveFailures',
          until: freezeUntil,
        },
      },
    }
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Swarm) return swarm
      if (resource === RESOURCE_MAP.Schedule) {
        return {
          status: {
            phase: 'Active',
            lastRunTime: freezeUntil,
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) return { items: [] }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(0)
    const initialStatusCall = applyStatus.mock.calls[0]
    const initialStatus = (initialStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(initialStatus.phase).toBe('Frozen')
    const initialGetCallCount = get.mock.calls.length

    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(get).toHaveBeenCalledTimes(initialGetCallCount)

    const remainingDelay = 2_500_000_000 - 2_147_483_647
    await vi.advanceTimersByTimeAsync(remainingDelay)

    expect(get).toHaveBeenCalledWith(RESOURCE_MAP.Swarm, 'torghut-quant', 'agents')
    const finalStatusCall = applyStatus.mock.calls.at(-1)
    const finalStatus = (finalStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(finalStatus.phase).toBe('Active')
    expect(finalStatus.freeze).toMatchObject({
      reason: 'NotFrozen',
      threshold: 2,
      durationMs: 60 * 60 * 1000,
      evidence: {
        triggeringRuns: [],
        stageStaleness: [],
        triggers: [],
      },
    })
    expect(finalStatus.freeze).toHaveProperty('until')
    expect(finalStatus.freeze).toHaveProperty('enteredAt')
  })

  it('uses different schedule names for long swarms with identical prefixes', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const makeSwarm = (suffix: string) => ({
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm' as const,
      metadata: { name: `${'a'.repeat(90)}-${suffix}`, namespace: 'agents', generation: 1, uid: `swarm-${suffix}` },
      spec: {
        owner: { id: `platform-owner-${suffix}`, channel: `swarm://owner/platform-${suffix}` },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: `agentrun-${suffix}` } },
          plan: { targetRef: { kind: 'AgentRun', name: `agentrun-${suffix}` } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: `orchestrationrun-${suffix}` } },
          verify: { targetRef: { kind: 'AgentRun', name: `agentrun-${suffix}` } },
        },
      },
    })

    await __test__.reconcileSwarm(kube, makeSwarm('one'), 'agents')
    await __test__.reconcileSwarm(kube, makeSwarm('two'), 'agents')

    const scheduleNames = apply.mock.calls.map((call) => {
      const payload = call[0] as Record<string, unknown>
      return asString(payload?.metadata ? (payload.metadata as Record<string, unknown>).name : undefined)
    })
    const uniqueNames = new Set(scheduleNames)
    expect(scheduleNames.filter((name): name is string => typeof name === 'string')).toHaveLength(8)
    expect(uniqueNames.size).toBe(8)
  })

  it('deletes managed schedules when swarm spec is invalid', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'invalid-swarm', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(12)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Invalid')
    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const ready = conditions.find((condition) => condition.type === 'Ready')
    expect(ready?.status).toBe('False')
    expect((ready as { reason?: string } | undefined)?.reason).toBe('InvalidSpec')
  })
})
