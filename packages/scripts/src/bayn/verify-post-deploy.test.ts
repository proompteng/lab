import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  BaynPostDeployFailure,
  parseExpectedBaynProduction,
  retryBaynPostDeployVerification,
  validateBaynPostDeploySnapshot,
  verifyReadOnlyBaynIdentity,
  verifyBaynRevisionLineage,
} from './verify-post-deploy'

const root = new URL('../../../../', import.meta.url)
const source = (path: string): string => readFileSync(new URL(path, root), 'utf8')

const expected = parseExpectedBaynProduction(
  source('argocd/applications/bayn/kustomization.yaml'),
  source('argocd/applications/bayn/deployment.yaml'),
  source('argocd/applications/bayn/execution-controller.yaml'),
)

const now = Date.parse('2026-08-15T07:30:00.000Z')
const fresh = '2026-08-15T07:29:30.000Z'

const env = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }))

const deployment = () => ({
  metadata: { name: 'bayn', generation: 12 },
  spec: {
    replicas: 1,
    template: {
      spec: {
        containers: [
          {
            name: 'bayn',
            image: expected.imageReference,
            env: env({
              BAYN_CODE_REVISION: expected.sourceRevision,
              BAYN_IMAGE_DIGEST: expected.imageDigest,
              BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH: expected.executionControllerPlanHash,
              BAYN_AUTHORITY_GENERATION_HASH: expected.authorityGenerationHash,
            }),
          },
        ],
      },
    },
  },
  status: {
    observedGeneration: 12,
    replicas: 1,
    updatedReplicas: 1,
    readyReplicas: 1,
    availableReplicas: 1,
  },
})

const controller = () => ({
  metadata: { name: 'bayn-execution-controller', generation: 5 },
  spec: {
    replicas: 1,
    template: {
      spec: {
        containers: [
          {
            name: 'execution-controller',
            image: expected.imageReference,
            env: env({
              BAYN_CODE_REVISION: expected.sourceRevision,
              BAYN_IMAGE_DIGEST: expected.imageDigest,
              BAYN_AUTHORITY_GENERATION_HASH: expected.authorityGenerationHash,
              BAYN_BROKER_ACCESS: 'read-only',
              BAYN_CAPITAL_AUTHORITY: 'none',
            }),
          },
        ],
      },
    },
  },
  status: {
    observedGeneration: 5,
    desiredReplicas: 1,
    readyReplicas: 1,
    availableReplicas: 1,
    deploymentId: 'dp_test',
    conditions: [{ type: 'Ready', status: 'True' }],
  },
})

const runtimeStatus = () => ({
  service: 'bayn',
  operational: { status: 'READY', ready: true, probeSequence: 10, checkedAt: fresh },
  dependencies: {
    postgresql: { status: 'AVAILABLE', checkedAt: fresh, error: null },
    signal: { status: 'AVAILABLE', checkedAt: fresh, error: null },
    tigerBeetle: { status: 'AVAILABLE', checkedAt: fresh, error: null },
    evidence: { status: 'AVAILABLE', checkedAt: fresh, error: null },
    cycle: { status: 'AVAILABLE', checkedAt: fresh, error: null },
    cycleRunner: { status: 'AVAILABLE', checkedAt: fresh, error: null },
  },
  autonomousCycleLoop: {
    configured: true,
    owner: 'Restate',
    lastPass: { result: 'SUCCESS', observedAt: fresh, outcome: 'NOT_DUE', notDueReason: 'MONTH_END_CADENCE' },
  },
  executionController: {
    configured: true,
    controllerKeyHash: 'a'.repeat(64),
    readAvailable: true,
    checkedAt: fresh,
    reasonCode: null,
    status: {
      active: true,
      planHash: expected.executionControllerPlanHash,
      epoch: 2,
      lastSequence: 40,
      lastOutcome: 'Blocked',
      lastReceiptHash: 'b'.repeat(64),
      completedAt: fresh,
      nextDueAt: '2026-08-15T07:30:00.000Z',
    },
  },
  capitalActivation: { _tag: 'NotConfigured' },
  broker: {
    configured: true,
    accountBound: true,
    readAvailable: true,
    checkedAt: fresh,
    executionEligible: false,
    executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
    reasonCode: null,
    error: null,
  },
  authority: {
    brokerEnvironment: 'sandbox',
    brokerAccess: 'read-only',
    capitalAuthority: 'none',
    brokerOrders: false,
    capitalPromotion: false,
    durable: {
      available: true,
      configured: true,
      maximum: 'observe',
      effective: 'observe',
      kill: 'clear',
      reason: null,
      updatedAt: fresh,
    },
  },
  cycle: {
    observationAvailable: true,
    condition: 'EXPECTED_WAIT',
    reason: 'MONTH_END_CADENCE',
    checkedAt: fresh,
    zeroMutation: true,
    error: null,
    mutations: { eventCount: 0, unresolvedCount: 0 },
    alerts: {
      stalled: false,
      unknownMutation: false,
      reconciliationStale: false,
      authorityIncoherent: false,
      killActive: false,
    },
    reconciliation: { status: 'EXACT', discrepancyCount: 0, coversLatestMutation: true, reconciledAt: fresh },
    reconciliationAgeMs: 30_000,
    reconciliationCoversLatestMutation: true,
  },
  build: {
    sourceRevision: expected.sourceRevision,
    image: { repository: expected.imageRepository, digest: expected.imageDigest },
    verification: 'embedded',
  },
  error: null,
})

const metrics = () => `
bayn_runtime_ready 1
bayn_autonomous_cycle_owner{owner="restate"} 1
bayn_autonomous_cycle_loop_health_available 1
bayn_execution_controller_configured 1
bayn_execution_controller_read_available 1
bayn_zero_mutation_confirmed 1
bayn_mutation_events_total 0
bayn_unresolved_mutations 0
bayn_reconciliation_available 1
bayn_reconciliation_exact 1
bayn_reconciliation_covers_latest_mutation 1
bayn_reconciliation_stale_threshold_seconds 120
bayn_broker_access{access="read-only"} 1
bayn_broker_access{access="mutation"} 0
bayn_broker_orders_enabled 0
bayn_capital_promotion_enabled 0
bayn_capital_authority{authority="none"} 1
`

const snapshot = () => ({
  application: {
    metadata: { name: 'bayn' },
    spec: {
      source: {
        path: 'argocd/applications/bayn',
        repoURL: 'https://github.com/proompteng/lab.git',
        targetRevision: 'main',
      },
      destination: { namespace: 'bayn' },
    },
    status: {
      sync: { status: 'Synced', revision: 'c'.repeat(40) },
      health: { status: 'Healthy' },
      operationState: { phase: 'Succeeded' },
    },
  },
  deployment: deployment(),
  executionController: controller(),
  readiness: { ready: true, status: 'READY', checkedAt: fresh, probeSequence: 10, failedDependencies: [] },
  status: runtimeStatus(),
  metrics: metrics(),
})

const failure = (operation: () => void): BaynPostDeployFailure => {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(BaynPostDeployFailure)
    return error as BaynPostDeployFailure
  }
  throw new Error('expected verification failure')
}

const asyncFailure = async (operation: () => Promise<void>): Promise<BaynPostDeployFailure> => {
  try {
    await operation()
  } catch (error) {
    expect(error).toBeInstanceOf(BaynPostDeployFailure)
    return error as BaynPostDeployFailure
  }
  throw new Error('expected verification failure')
}

describe('Bayn production post-deploy contract', () => {
  test('parses the current immutable production manifest contract', () => {
    expect(expected.sourceRevision).toHaveLength(40)
    expect(expected.imageTag).toBe(`sha-${expected.sourceRevision}`)
    expect(expected.imageReference).toBe(`${expected.imageRepository}:${expected.imageTag}@${expected.imageDigest}`)
    expect(expected.executionControllerPlanHash).toHaveLength(64)
    expect(expected.authorityGenerationHash).toHaveLength(64)
  })

  test('accepts a healthy read-only Restate-owned production snapshot', () => {
    expect(() => validateBaynPostDeploySnapshot(snapshot(), expected, now)).not.toThrow()
  })

  test('rejects a status payload with a missing production dependency', () => {
    const value = snapshot()
    delete (value.status.dependencies as Partial<typeof value.status.dependencies>).signal

    expect(() => validateBaynPostDeploySnapshot(value, expected, now)).toThrow(
      'status.dependencies must contain exactly cycle, cycleRunner, evidence, postgresql, signal, tigerBeetle',
    )
  })

  test('rejects a status payload with an unexpected production dependency', () => {
    const value = snapshot()
    ;(value.status.dependencies as Record<string, unknown>).cache = {
      status: 'AVAILABLE',
      checkedAt: fresh,
      error: null,
    }

    expect(() => validateBaynPostDeploySnapshot(value, expected, now)).toThrow(
      'status.dependencies must contain exactly cycle, cycleRunner, evidence, postgresql, signal, tigerBeetle',
    )
  })

  test('fails while Argo reports the live degraded rollout', () => {
    const value = snapshot()
    ;(value.application as any).status.health.status = 'Degraded'
    expect(failure(() => validateBaynPostDeploySnapshot(value, expected, now))).toMatchObject({
      code: 'ARGO_NOT_CONVERGED',
      retryable: true,
    })
  })

  test('fails closed on broker mutation authority', () => {
    const value = snapshot()
    ;(value.status as any).authority.brokerAccess = 'mutation'
    expect(failure(() => validateBaynPostDeploySnapshot(value, expected, now))).toMatchObject({
      code: 'PRODUCTION_CONTRACT_VIOLATION',
      retryable: false,
    })
  })

  test('fails closed on any durable mutation evidence', () => {
    const value = snapshot()
    ;(value.status as any).cycle.mutations.eventCount = 1
    expect(failure(() => validateBaynPostDeploySnapshot(value, expected, now))).toMatchObject({
      code: 'PRODUCTION_CONTRACT_VIOLATION',
      retryable: false,
    })
  })

  test('rejects reconciliation at the live configured stale threshold', () => {
    const value = snapshot()
    ;(value.status as any).cycle.reconciliationAgeMs = 120_000
    expect(failure(() => validateBaynPostDeploySnapshot(value, expected, now))).toMatchObject({
      code: 'RUNTIME_NOT_READY',
      retryable: true,
    })
  })

  test('rejects missing or ambiguous reconciliation threshold metrics', () => {
    const missing = snapshot()
    missing.metrics = missing.metrics.replace('bayn_reconciliation_stale_threshold_seconds 120\n', '')
    expect(failure(() => validateBaynPostDeploySnapshot(missing, expected, now))).toMatchObject({
      code: 'RUNTIME_NOT_READY',
      retryable: true,
    })

    const duplicate = snapshot()
    duplicate.metrics += 'bayn_reconciliation_stale_threshold_seconds 121\n'
    expect(failure(() => validateBaynPostDeploySnapshot(duplicate, expected, now))).toMatchObject({
      code: 'RUNTIME_NOT_READY',
      retryable: true,
    })
  })

  test('rejects a stale or inactive execution-controller projection', () => {
    const inactive = snapshot()
    ;(inactive.status as any).executionController.status.active = false
    expect(failure(() => validateBaynPostDeploySnapshot(inactive, expected, now))).toMatchObject({
      code: 'RUNTIME_NOT_READY',
      retryable: true,
    })

    const stale = snapshot()
    ;(stale.status as any).executionController.status.completedAt = '2026-08-15T07:20:00.000Z'
    expect(failure(() => validateBaynPostDeploySnapshot(stale, expected, now))).toMatchObject({
      code: 'RUNTIME_NOT_READY',
      retryable: true,
    })
  })

  test('rejects live workload image drift', () => {
    const value = snapshot()
    ;(value.executionController as any).spec.template.spec.containers[0].image = `${expected.imageRepository}:latest`
    expect(failure(() => validateBaynPostDeploySnapshot(value, expected, now))).toMatchObject({
      code: 'WORKLOAD_NOT_CONVERGED',
      retryable: true,
    })
  })

  test('retries while the RestateDeployment status has not been projected yet', () => {
    const value = snapshot()
    delete (value.executionController as { status?: unknown }).status

    const result = failure(() => validateBaynPostDeploySnapshot(value, expected, now))
    expect(result).toMatchObject({
      code: 'WORKLOAD_NOT_CONVERGED',
      retryable: true,
    })
    expect(result.message).toContain('executionController.status is not projected yet')
  })

  test('rejects live authority-generation drift in both production workloads', () => {
    const deploymentDrift = snapshot()
    ;(deploymentDrift.deployment as any).spec.template.spec.containers[0].env.find(
      (item: { name: string }) => item.name === 'BAYN_AUTHORITY_GENERATION_HASH',
    ).value = 'd'.repeat(64)
    expect(failure(() => validateBaynPostDeploySnapshot(deploymentDrift, expected, now))).toMatchObject({
      code: 'WORKLOAD_NOT_CONVERGED',
      retryable: true,
    })

    const controllerDrift = snapshot()
    ;(controllerDrift.executionController as any).spec.template.spec.containers[0].env.find(
      (item: { name: string }) => item.name === 'BAYN_AUTHORITY_GENERATION_HASH',
    ).value = 'e'.repeat(64)
    expect(failure(() => validateBaynPostDeploySnapshot(controllerDrift, expected, now))).toMatchObject({
      code: 'WORKLOAD_NOT_CONVERGED',
      retryable: true,
    })
  })

  test('rejects sensitive identity fields from the public status payload', () => {
    const value = snapshot()
    ;(value.status as any).broker.accountId = 'forbidden'
    expect(failure(() => validateBaynPostDeploySnapshot(value, expected, now))).toMatchObject({
      code: 'PRODUCTION_CONTRACT_VIOLATION',
      retryable: false,
    })
  })

  test('retries only retryable convergence failures', async () => {
    let attempts = 0
    let clock = 0
    await retryBaynPostDeployVerification(
      async () => {
        attempts += 1
        if (attempts < 3) throw new BaynPostDeployFailure('RUNTIME_NOT_READY', 'warming', true)
      },
      {
        deadlineMs: 100,
        intervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds
        },
      },
    )
    expect(attempts).toBe(3)
  })

  test('fails immediately on a non-retryable production violation', async () => {
    let attempts = 0
    expect(
      await asyncFailure(() =>
        retryBaynPostDeployVerification(
          async () => {
            attempts += 1
            throw new BaynPostDeployFailure('PRODUCTION_CONTRACT_VIOLATION', 'unsafe', false)
          },
          { deadlineMs: 100, intervalMs: 10, sleep: async () => undefined },
        ),
      ),
    ).toMatchObject({ code: 'PRODUCTION_CONTRACT_VIOLATION' })
    expect(attempts).toBe(1)
  })

  test('accepts a descendant Argo revision only when Bayn manifests are unchanged', async () => {
    const expectedRevision = '1'.repeat(40)
    const reconciledRevision = '2'.repeat(40)
    const commands: string[] = []
    const run = async (command: readonly string[]) => {
      commands.push(command.join(' '))
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await verifyBaynRevisionLineage(run, expectedRevision, reconciledRevision)
    expect(commands).toContain(
      `git diff --quiet ${expectedRevision}..${reconciledRevision} -- argocd/applications/bayn`,
    )
  })

  test('fails closed when the verifier identity has a destructive subresource permission', async () => {
    const run = async (command: readonly string[]) => {
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      return {
        stdout: verb === 'update' && resource === 'deployments.apps/scale' ? 'yes\n' : 'no\n',
        stderr: '',
        exitCode: 0,
      }
    }
    expect(await asyncFailure(() => verifyReadOnlyBaynIdentity(run))).toMatchObject({
      code: 'PRODUCTION_CONTRACT_VIOLATION',
      retryable: false,
    })
  })
})
