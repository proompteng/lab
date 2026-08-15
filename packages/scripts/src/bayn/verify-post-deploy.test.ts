import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  BaynPostDeployFailure,
  fetchBaynPostDeploySnapshot,
  parseExpectedBaynProduction,
  readRestateArgoRevision,
  retryBaynPostDeployVerification,
  validateBaynPostDeploySnapshot,
  verifyReadOnlyBaynIdentity,
  verifyBaynRevisionLineage,
  verifyRestateRevisionLineage,
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
              BAYN_BROKER_ACCESS: 'read-only',
              BAYN_CAPITAL_AUTHORITY: 'none',
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
    cadence: {
      condition: 'UNKNOWN',
      reason: 'NO_PASS_RECORDED',
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: { status: 'UNKNOWN', reason: 'FUTURE_CALENDAR_EVIDENCE_UNAVAILABLE' },
    },
    lastPass: null,
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
    condition: 'WAITING',
    reason: 'LAST_CYCLE_BLOCKED',
    checkedAt: fresh,
    unfinishedCycleCount: 0,
    zeroMutation: false,
    error: null,
    mutations: {
      eventCount: 356,
      recoveryFoundCount: 350,
      approvedIntentCount: 0,
      acknowledgedIntentCount: 0,
      unresolvedCount: 0,
      oldestUnresolvedAt: null,
      latestOccurredAt: '2026-08-13T12:45:23.676Z',
    },
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
bayn_mutation_events_total 356
bayn_intents{state="approved"} 0
bayn_intents{state="acknowledged"} 0
bayn_unresolved_mutations 0
bayn_reconciliation_available 1
bayn_reconciliation_exact 1
bayn_reconciliation_covers_latest_mutation 1
bayn_reconciliation_stale_threshold_seconds 120
bayn_broker_access{access="read-only"} 1
bayn_broker_access{access="mutation"} 0
bayn_authority_coherent 1
bayn_authority_kill_active 0
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
  restateApplications: {
    items: [
      {
        metadata: { name: 'restate' },
        spec: {
          source: {
            repoURL: 'https://github.com/proompteng/lab.git',
            path: 'argocd/applications/restate',
            targetRevision: 'main',
          },
        },
        status: { sync: { status: 'Synced', revision: 'c'.repeat(40) }, health: { status: 'Healthy' } },
      },
      {
        metadata: { name: 'restate-operator' },
        spec: {
          source: {
            repoURL: 'ghcr.io/restatedev',
            chart: 'restate-operator-helm',
            targetRevision: '3.0.0',
          },
        },
        status: { sync: { status: 'Synced', revision: '3.0.0' }, health: { status: 'Healthy' } },
      },
      {
        metadata: { name: 'restate-operator-crds' },
        spec: {
          source: {
            repoURL: 'ghcr.io/restatedev',
            chart: 'restate-operator-crds',
            targetRevision: '3.0.0',
          },
        },
        status: { sync: { status: 'Synced', revision: '3.0.0' }, health: { status: 'Healthy' } },
      },
    ],
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

  test('accepts historical mutation evidence after exact reconciliation but rejects active mutation work', () => {
    expect(() => validateBaynPostDeploySnapshot(snapshot(), expected, now)).not.toThrow()

    const unresolved = snapshot()
    ;(unresolved.status as any).cycle.mutations.unresolvedCount = 1
    expect(failure(() => validateBaynPostDeploySnapshot(unresolved, expected, now))).toMatchObject({
      code: 'PRODUCTION_CONTRACT_VIOLATION',
      retryable: false,
    })

    const value = snapshot()
    ;(value.status as any).cycle.mutations.approvedIntentCount = 1
    expect(failure(() => validateBaynPostDeploySnapshot(value, expected, now))).toMatchObject({
      code: 'PRODUCTION_CONTRACT_VIOLATION',
      retryable: false,
    })
  })

  test('requires the Restate runtime and operator Argo applications to remain healthy', () => {
    const value = snapshot()
    ;(value.restateApplications.items[1] as any).status.health.status = 'Degraded'
    expect(failure(() => validateBaynPostDeploySnapshot(value, expected, now))).toMatchObject({
      code: 'ARGO_NOT_CONVERGED',
      retryable: true,
    })
  })

  test('binds Restate Argo applications to their expected sources and synced revisions', () => {
    const sourceDrift = snapshot()
    ;(sourceDrift.restateApplications.items[0] as any).spec.source.path = 'argocd/applications/other'
    expect(failure(() => validateBaynPostDeploySnapshot(sourceDrift, expected, now))).toMatchObject({
      code: 'ARGO_NOT_CONVERGED',
      retryable: true,
    })

    const operatorDrift = snapshot()
    ;(operatorDrift.restateApplications.items[1] as any).spec.source.targetRevision = '3.1.0'
    expect(failure(() => validateBaynPostDeploySnapshot(operatorDrift, expected, now))).toMatchObject({
      code: 'ARGO_NOT_CONVERGED',
      retryable: true,
    })

    const operatorRevisionDrift = snapshot()
    ;(operatorRevisionDrift.restateApplications.items[2] as any).status.sync.revision = '2.9.0'
    expect(failure(() => validateBaynPostDeploySnapshot(operatorRevisionDrift, expected, now))).toMatchObject({
      code: 'ARGO_NOT_CONVERGED',
      retryable: true,
    })

    expect(readRestateArgoRevision(snapshot().restateApplications)).toBe('c'.repeat(40))
  })

  test('rejects an unhealthy Restate-owned cadence while allowing no process-local pass record', () => {
    const value = snapshot()
    expect((value.status.autonomousCycleLoop as any).lastPass).toBeNull()
    expect(() => validateBaynPostDeploySnapshot(value, expected, now)).not.toThrow()

    ;(value.status.autonomousCycleLoop as any).cadence = {
      ...(value.status.autonomousCycleLoop as any).cadence,
      condition: 'STALLED',
      reason: 'RUNNER_UNAVAILABLE',
    }
    expect(failure(() => validateBaynPostDeploySnapshot(value, expected, now))).toMatchObject({
      code: 'RUNTIME_NOT_READY',
      retryable: true,
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

  test('fails closed on live public Deployment authority drift', () => {
    for (const [name, value] of [
      ['BAYN_BROKER_ACCESS', 'mutation'],
      ['BAYN_CAPITAL_AUTHORITY', 'granted'],
    ] as const) {
      const drift = snapshot()
      ;(drift.deployment as any).spec.template.spec.containers[0].env.find(
        (item: { name: string }) => item.name === name,
      ).value = value
      expect(failure(() => validateBaynPostDeploySnapshot(drift, expected, now))).toMatchObject({
        code: 'PRODUCTION_CONTRACT_VIOLATION',
        retryable: false,
      })
    }
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

  test('requires the main-tracking Restate application to reconcile the triggering revision lineage', async () => {
    const expectedRevision = '1'.repeat(40)
    const reconciledRevision = '2'.repeat(40)
    const commands: string[] = []
    const run = async (command: readonly string[]) => {
      commands.push(command.join(' '))
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    await verifyRestateRevisionLineage(run, expectedRevision, reconciledRevision)
    expect(commands).toContain(
      `git diff --quiet ${expectedRevision}..${reconciledRevision} -- argocd/applications/restate`,
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

  test('retries authorization probe transport failures instead of treating them as privilege drift', async () => {
    let attempts = 0
    const run = async (_command: readonly string[]) => {
      attempts += 1
      return attempts === 1
        ? { stdout: '', stderr: 'temporary API transport failure', exitCode: 1 }
        : { stdout: 'no\n', stderr: '', exitCode: 0 }
    }

    expect(await asyncFailure(() => verifyReadOnlyBaynIdentity(run))).toMatchObject({
      code: 'READ_UNAVAILABLE',
      retryable: true,
    })
  })

  test('reads sanitized Bayn HTTP directly instead of using the Kubernetes service proxy', async () => {
    const value = snapshot()
    const commands: string[] = []
    const urls: string[] = []
    const run = async (command: readonly string[]) => {
      const joined = command.join(' ')
      commands.push(joined)
      if (joined.includes('get application bayn ')) {
        return { stdout: JSON.stringify(value.application), stderr: '', exitCode: 0 }
      }
      if (joined.includes('get application restate restate-operator restate-operator-crds ')) {
        return { stdout: JSON.stringify(value.restateApplications), stderr: '', exitCode: 0 }
      }
      if (joined.includes('get deployment bayn ')) {
        return { stdout: JSON.stringify(value.deployment), stderr: '', exitCode: 0 }
      }
      if (joined.includes('get restatedeployment bayn-execution-controller ')) {
        return { stdout: JSON.stringify(value.executionController), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'unexpected command', exitCode: 1 }
    }
    const readBaynHttp = async (url: string): Promise<string> => {
      urls.push(url)
      if (url.endsWith('/readyz')) return JSON.stringify(value.readiness)
      if (url.endsWith('/v1/status')) return JSON.stringify(value.status)
      if (url.endsWith('/metrics')) return value.metrics
      throw new Error(`unexpected URL ${url}`)
    }

    const fetched = await fetchBaynPostDeploySnapshot(run, readBaynHttp)
    expect(fetched).toEqual(value)
    expect(commands.some((command) => command.includes('services/bayn:80/proxy'))).toBe(false)
    expect(urls).toEqual([
      'http://bayn.bayn.svc.cluster.local:80/readyz',
      'http://bayn.bayn.svc.cluster.local:80/v1/status',
      'http://bayn.bayn.svc.cluster.local:80/metrics',
    ])
  })
})
