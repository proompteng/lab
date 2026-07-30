import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  parseExpectedPromotion,
  readArgoSyncRevision,
  redactSensitive,
  runCommand,
  runWithinDeadline,
  retryVerification,
  verifyArgoRevision,
  validateReadOnlyPermissions as validateProductionReadOnlyPermissions,
  validateSnapshot as validateProductionSnapshot,
  VerificationFailure,
  type ExpectedPromotion,
  type RunCommand,
  type VerificationSnapshot,
} from './bayn-post-deploy-verify'

const expectedArgoRevision = '27f279697152319abacac0d1ea806a210671ca8c'
const descendantArgoRevision = '5fa8e184d6001ff868093d50d110af4be0639695'
const sourceRevision = 'c7794ce4892ae7d9d6a7b38480a02fe1b39399b0'
const oldSourceRevision = '6be9f985e866d70748bc11d21ca92731c81a5736'
const digest = 'sha256:13579bcffc30f6f2eaa4ba2054347b96888117236b286e27ac63374d9ea1db53'
const oldDigest = 'sha256:5b46c9b7ed1ca3f7617c9357f0fedca6226badd037ea4fbed2daf78fa8aa5564'
const repository = 'registry.ide-newton.ts.net/lab/bayn'
const tag = `sha-${sourceRevision}`
const imageReference = `${repository}:${tag}@${digest}`
const verificationNowMs = Date.parse('2026-07-30T06:52:30.000Z')

const kustomization = `
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
images:
  - name: ${repository}
    newName: ${repository}
    newTag: "${tag}"
    digest: ${digest}
`

const deploymentManifest = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: bayn
          image: ${repository}
          env:
            - name: BAYN_CODE_REVISION
              value: ${sourceRevision}
            - name: BAYN_IMAGE_REPOSITORY
              value: ${repository}
            - name: BAYN_IMAGE_DIGEST
              value: ${digest}
            - name: BAYN_BROKER_ENVIRONMENT
              value: sandbox
            - name: BAYN_MAXIMUM_AUTHORITY
              value: OBSERVE
            - name: BAYN_ALPACA_ACCOUNT_ID
              valueFrom:
                secretKeyRef:
                  name: bayn-alpaca-auth
                  key: account-id
      volumes:
        - name: postgres-ca
          secret:
            secretName: bayn-db-ca
`

const expected = parseExpectedPromotion(kustomization, deploymentManifest)
const readOnlyAuthorizationRules = [
  'selfsubjectreviews.authentication.k8s.io [] [] [create]',
  'selfsubjectaccessreviews.authorization.k8s.io [] [] [create]',
  'selfsubjectrulesreviews.authorization.k8s.io [] [] [create]',
  'deployments.apps [] [] [get list watch]',
].join('\n')

const validateReadOnlyPermissions = (
  run: RunCommand,
  signal: AbortSignal,
  secretNames: readonly string[] = [],
): Promise<void> =>
  validateProductionReadOnlyPermissions(
    async (command, commandSignal) =>
      command.includes('--list')
        ? { stdout: readOnlyAuthorizationRules, stderr: '', exitCode: 0 }
        : run(command, commandSignal),
    signal,
    secretNames,
  )

const validateSnapshot = (
  snapshot: VerificationSnapshot,
  reconciledRevision: string,
  expectedPromotion: ExpectedPromotion,
  promotionRevision = reconciledRevision,
): void => {
  validateProductionSnapshot(snapshot, reconciledRevision, expectedPromotion, promotionRevision, verificationNowMs)
}

const dependency = () => ({ status: 'AVAILABLE', checkedAt: '2026-07-30T06:52:25.210Z', error: null })

const baseSnapshot = (): VerificationSnapshot => ({
  application: {
    metadata: { name: 'bayn' },
    spec: {
      destination: { namespace: 'bayn' },
      source: {
        path: 'argocd/applications/bayn',
        repoURL: 'https://github.com/proompteng/lab.git',
        targetRevision: 'main',
      },
    },
    status: {
      sync: { status: 'Synced', revision: expectedArgoRevision },
      health: { status: 'Healthy' },
      operationState: {
        phase: 'Succeeded',
        syncResult: {
          revision: expectedArgoRevision,
          resources: [
            {
              group: 'apps',
              kind: 'Deployment',
              name: 'bayn',
              namespace: 'bayn',
              status: 'Synced',
            },
          ],
        },
      },
      summary: { images: [imageReference] },
      resources: [{ group: 'apps', kind: 'Deployment', name: 'bayn', namespace: 'bayn', status: 'Synced' }],
    },
  },
  deployment: {
    metadata: { name: 'bayn', generation: 101 },
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [
            {
              name: 'bayn',
              image: imageReference,
              env: [
                { name: 'BAYN_CODE_REVISION', value: sourceRevision },
                { name: 'BAYN_IMAGE_DIGEST', value: digest },
              ],
            },
          ],
        },
      },
    },
    status: {
      observedGeneration: 101,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      unavailableReplicas: 0,
      terminatingReplicas: 0,
    },
  },
  pods: {
    items: [
      {
        metadata: { name: 'bayn-current' },
        spec: {
          containers: [
            {
              name: 'bayn',
              image: imageReference,
              env: [
                { name: 'BAYN_CODE_REVISION', value: sourceRevision },
                { name: 'BAYN_IMAGE_DIGEST', value: digest },
              ],
            },
          ],
        },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [
            {
              name: 'bayn',
              ready: true,
              started: true,
              restartCount: 0,
              imageID: `${repository}@${digest}`,
              state: { running: { startedAt: '2026-07-30T06:49:41Z' } },
              lastState: {},
            },
          ],
        },
      },
    ],
  },
  readiness: {
    ready: true,
    status: 'READY',
    checkedAt: '2026-07-30T06:52:25.210Z',
    probeSequence: 6,
    failedDependencies: [],
  },
  metrics: `
# HELP bayn_reconciliation_stale_threshold_seconds Configured reconciliation staleness threshold.
# TYPE bayn_reconciliation_stale_threshold_seconds gauge
bayn_reconciliation_stale_threshold_seconds 120
`,
  status: {
    service: 'bayn',
    operational: {
      status: 'READY',
      ready: true,
      probeSequence: 6,
      checkedAt: '2026-07-30T06:52:25.210Z',
    },
    dependencies: {
      postgresql: dependency(),
      signal: dependency(),
      tigerBeetle: dependency(),
      evidence: dependency(),
      cycle: dependency(),
      cycleRunner: dependency(),
    },
    autonomousCycleLoop: {
      configured: true,
      startedAt: '2026-07-30T06:49:45.348Z',
      lastPass: {
        result: 'SUCCESS',
        observedAt: '2026-07-30T06:52:27.464Z',
        outcome: 'NOT_DUE',
      },
    },
    broker: {
      configured: true,
      accountBound: true,
      readAvailable: true,
      checkedAt: '2026-07-30T06:52:25.210Z',
      executionEligible: false,
      executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
      reasonCode: null,
      error: null,
    },
    authority: {
      brokerEnvironment: 'sandbox',
      brokerAccess: 'read-only',
      capitalAuthority: 'none',
      durable: {
        available: true,
        configured: true,
        maximum: 'observe',
        effective: 'observe',
        kill: 'clear',
        reason: null,
        updatedAt: '2026-07-28T06:49:28.305Z',
      },
      brokerOrders: false,
      capitalPromotion: false,
    },
    cycle: {
      observationAvailable: true,
      condition: 'WAITING',
      reason: 'NO_CYCLE_RECORDED',
      checkedAt: '2026-07-30T06:52:25.210Z',
      reconciliation: {
        reconciliationId: 'a4cbd66fe988e2fc1c9e9d0e29fe10cfb00c6e64c6ea248a5659342c3139ca23',
        status: 'EXACT',
        discrepancyCount: 0,
        reconciledAt: '2026-07-30T06:51:55.079Z',
        coversLatestMutation: true,
      },
      reconciliationCoversLatestMutation: true,
      reconciliationAgeMs: 30_131,
      mutations: {
        eventCount: 0,
        unresolvedCount: 0,
        oldestUnresolvedAt: null,
        latestOccurredAt: null,
      },
      zeroMutation: true,
      alerts: {
        cycleStalled: false,
        cycleFailed: false,
        unknownMutationStale: false,
        reconciliationBlocked: false,
        killActive: false,
        authorityIncoherent: false,
      },
      error: null,
    },
    build: {
      sourceRevision,
      image: { repository, digest },
      verification: 'embedded',
    },
    error: null,
  },
})

const clone = (): VerificationSnapshot => structuredClone(baseSnapshot())

const captureFailure = (operation: () => void): VerificationFailure => {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(VerificationFailure)
    return error as VerificationFailure
  }
  throw new Error('expected verifier failure')
}

describe('manifest contract', () => {
  test('reads the exact full source, tag, and digest', () => {
    expect(expected).toEqual({
      sourceRevision,
      tag,
      digest,
      repository,
      imageReference,
      secretNames: ['bayn-alpaca-auth', 'bayn-db-ca'],
    })
  })

  test('rejects a deployment without production Secret references', () => {
    const withoutSecrets = deploymentManifest
      .replace(/\n            - name: BAYN_ALPACA_ACCOUNT_ID[\s\S]*?                  key: account-id/, '')
      .replace(/\n      volumes:[\s\S]*?            secretName: bayn-db-ca/, '')
    expect(captureFailure(() => parseExpectedPromotion(kustomization, withoutSecrets)).code).toBe('INVALID_MANIFEST')
  })

  test('rejects truncated or mutable tags', () => {
    const failure = captureFailure(() =>
      parseExpectedPromotion(kustomization.replace(tag, 'latest'), deploymentManifest),
    )
    expect(failure.code).toBe('INVALID_MANIFEST')
    const truncated = captureFailure(() =>
      parseExpectedPromotion(kustomization.replace(tag, `sha-${sourceRevision.slice(0, 12)}`), deploymentManifest),
    )
    expect(truncated.code).toBe('INVALID_MANIFEST')
  })
})

describe('production snapshot', () => {
  test('accepts exact source and digest with a successful idle NOT_DUE pass', () => {
    expect(() => validateSnapshot(baseSnapshot(), expectedArgoRevision, expected)).not.toThrow()
  })

  test('accepts a verified descendant Argo revision with unchanged manifests and promotion history', () => {
    const snapshot = clone()
    const application = snapshot.application as any
    application.status.sync.revision = descendantArgoRevision
    application.status.operationState.syncResult.revision = descendantArgoRevision
    application.status.history = [
      {
        revision: expectedArgoRevision,
        deployedAt: '2026-07-30T06:49:31Z',
        source: {
          path: 'argocd/applications/bayn',
          repoURL: 'https://github.com/proompteng/lab.git',
          targetRevision: 'main',
        },
      },
    ]
    expect(readArgoSyncRevision(snapshot.application)).toBe(descendantArgoRevision)
    expect(() => validateSnapshot(snapshot, descendantArgoRevision, expected, expectedArgoRevision)).not.toThrow()
  })

  test('accepts a verified descendant when Argo skipped the intermediate promotion history', () => {
    const snapshot = clone()
    const application = snapshot.application as any
    application.status.sync.revision = descendantArgoRevision
    application.status.operationState.syncResult.revision = descendantArgoRevision
    delete application.status.history

    expect(() => validateSnapshot(snapshot, descendantArgoRevision, expected, expectedArgoRevision)).not.toThrow()
  })

  test('accepts a descendant selective sync that omits the unchanged Bayn Deployment', () => {
    const snapshot = clone()
    const application = snapshot.application as any
    application.status.sync.revision = descendantArgoRevision
    application.status.operationState.syncResult.revision = descendantArgoRevision
    application.status.operationState.syncResult.resources = [
      {
        group: '',
        kind: 'ConfigMap',
        name: 'bayn-egress-proxy-selective-sync',
        namespace: 'bayn',
        status: 'Synced',
      },
    ]
    application.status.history = [
      {
        revision: expectedArgoRevision,
        deployedAt: '2026-07-30T06:49:31Z',
        source: {
          path: 'argocd/applications/bayn',
          repoURL: 'https://github.com/proompteng/lab.git',
          targetRevision: 'main',
        },
      },
    ]

    expect(() => validateSnapshot(snapshot, descendantArgoRevision, expected, expectedArgoRevision)).not.toThrow()
  })

  test('accepts an exact selective sync that omits an unchanged Bayn Deployment', () => {
    const snapshot = clone()
    ;(snapshot.application as any).status.operationState.syncResult.resources = []
    expect(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).not.toThrow()
  })

  test('rejects a Bayn Deployment entry that is present but not Synced', () => {
    const snapshot = clone()
    ;(snapshot.application as any).status.operationState.syncResult.resources[0].status = 'OutOfSync'
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'ARGO_NOT_CONVERGED',
    )
  })

  test('rejects the known Argo-new-revision old-image false positive', () => {
    const snapshot = clone()
    const deployment = snapshot.deployment as any
    const pod = (snapshot.pods as any).items[0]
    const oldImage = `${repository}:sha-${oldSourceRevision}@${oldDigest}`
    deployment.spec.template.spec.containers[0].image = oldImage
    deployment.spec.template.spec.containers[0].env[0].value = oldSourceRevision
    deployment.spec.template.spec.containers[0].env[1].value = oldDigest
    pod.spec.containers[0].image = oldImage
    pod.spec.containers[0].env[0].value = oldSourceRevision
    pod.spec.containers[0].env[1].value = oldDigest
    pod.status.containerStatuses[0].imageID = `${repository}@${oldDigest}`
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'DEPLOYMENT_NOT_CONVERGED',
    )
  })

  test('rejects stale Argo reconciliation', () => {
    const snapshot = clone()
    ;(snapshot.application as any).status.sync.revision = oldSourceRevision
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'ARGO_NOT_CONVERGED',
    )
  })

  test('rejects any container restart or termination evidence', () => {
    const snapshot = clone()
    ;(snapshot.pods as any).items[0].status.containerStatuses[0].restartCount = 1
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'PRODUCTION_CONTRACT_VIOLATION',
    )
  })

  test('rejects unhealthy readiness and dependencies', () => {
    const readiness = clone()
    ;(readiness.readiness as any).ready = false
    expect(captureFailure(() => validateSnapshot(readiness, expectedArgoRevision, expected)).code).toBe(
      'ENDPOINT_UNAVAILABLE',
    )

    const dependencyFailure = clone()
    ;(dependencyFailure.status as any).dependencies.signal.status = 'UNAVAILABLE'
    expect(captureFailure(() => validateSnapshot(dependencyFailure, expectedArgoRevision, expected)).code).toBe(
      'ENDPOINT_UNAVAILABLE',
    )

    const futureDependencyFailure = clone()
    ;(futureDependencyFailure.status as any).dependencies.futureSafetyRead = {
      status: 'UNAVAILABLE',
      checkedAt: '2026-07-30T06:52:25.210Z',
      error: 'redacted',
    }
    expect(captureFailure(() => validateSnapshot(futureDependencyFailure, expectedArgoRevision, expected)).code).toBe(
      'ENDPOINT_UNAVAILABLE',
    )
  })

  test.each([
    [
      'broker access',
      (snapshot: VerificationSnapshot) => ((snapshot.status as any).authority.brokerAccess = 'mutation'),
    ],
    [
      'capital authority',
      (snapshot: VerificationSnapshot) => ((snapshot.status as any).authority.capitalAuthority = 'paper'),
    ],
    ['broker orders', (snapshot: VerificationSnapshot) => ((snapshot.status as any).authority.brokerOrders = true)],
    [
      'capital promotion',
      (snapshot: VerificationSnapshot) => ((snapshot.status as any).authority.capitalPromotion = true),
    ],
    [
      'durable maximum',
      (snapshot: VerificationSnapshot) => ((snapshot.status as any).authority.durable.maximum = 'paper'),
    ],
  ])('rejects authority escalation: %s', (_name, mutate) => {
    const snapshot = clone()
    mutate(snapshot)
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'PRODUCTION_CONTRACT_VIOLATION',
    )
  })

  test('rejects any broker/account mutation evidence', () => {
    const snapshot = clone()
    ;(snapshot.status as any).cycle.mutations.eventCount = 1
    ;(snapshot.status as any).cycle.zeroMutation = false
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'PRODUCTION_CONTRACT_VIOLATION',
    )
  })

  test('rejects missing required reconciliation without forcing a DUE cycle', () => {
    const snapshot = clone()
    ;(snapshot.status as any).cycle.reconciliation = null
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'ENDPOINT_UNAVAILABLE',
    )
    expect((snapshot.status as any).autonomousCycleLoop.lastPass.outcome).toBe('NOT_DUE')
  })

  test('rejects reconciliation at or beyond the live stale threshold', () => {
    const snapshot = clone()
    ;(snapshot.status as any).cycle.reconciliationAgeMs = 120_000
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'ENDPOINT_UNAVAILABLE',
    )
  })

  test('rejects missing or ambiguous reconciliation threshold metrics', () => {
    const missing = clone()
    ;(missing as any).metrics = '# no reconciliation threshold\n'
    expect(captureFailure(() => validateSnapshot(missing, expectedArgoRevision, expected)).code).toBe(
      'ENDPOINT_UNAVAILABLE',
    )

    const duplicate = clone()
    ;(duplicate as any).metrics = [
      'bayn_reconciliation_stale_threshold_seconds 120',
      'bayn_reconciliation_stale_threshold_seconds 121',
    ].join('\n')
    expect(captureFailure(() => validateSnapshot(duplicate, expectedArgoRevision, expected)).code).toBe(
      'ENDPOINT_UNAVAILABLE',
    )
  })

  test.each([
    [
      'readiness probe',
      (snapshot: VerificationSnapshot, staleAt: string) => ((snapshot.readiness as any).checkedAt = staleAt),
    ],
    [
      'operational health probe',
      (snapshot: VerificationSnapshot, staleAt: string) => ((snapshot.status as any).operational.checkedAt = staleAt),
    ],
    [
      'dependency health probe',
      (snapshot: VerificationSnapshot, staleAt: string) =>
        ((snapshot.status as any).dependencies.postgresql.checkedAt = staleAt),
    ],
    [
      'autonomous loop pass',
      (snapshot: VerificationSnapshot, staleAt: string) =>
        ((snapshot.status as any).autonomousCycleLoop.lastPass.observedAt = staleAt),
    ],
    [
      'broker probe',
      (snapshot: VerificationSnapshot, staleAt: string) => ((snapshot.status as any).broker.checkedAt = staleAt),
    ],
    [
      'cycle projection',
      (snapshot: VerificationSnapshot, staleAt: string) => ((snapshot.status as any).cycle.checkedAt = staleAt),
    ],
    [
      'reconciliation receipt',
      (snapshot: VerificationSnapshot, staleAt: string) =>
        ((snapshot.status as any).cycle.reconciliation.reconciledAt = staleAt),
    ],
  ])('rejects stale cached %s evidence', (_name, mutate) => {
    const snapshot = clone()
    mutate(snapshot, '2026-07-30T06:50:29.999Z')
    ;(snapshot.status as any).cycle.reconciliationAgeMs = 1
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'ENDPOINT_UNAVAILABLE',
    )
  })

  test('rejects timestamps beyond the bounded clock-skew allowance', () => {
    const snapshot = clone()
    ;(snapshot.status as any).operational.checkedAt = '2026-07-30T06:52:35.001Z'
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'ENDPOINT_UNAVAILABLE',
    )
  })

  test('rejects missing required status fields', () => {
    const snapshot = clone()
    delete (snapshot.status as any).cycle.alerts.killActive
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'PRODUCTION_CONTRACT_VIOLATION',
    )
  })

  test('rejects any newly added active alert', () => {
    const snapshot = clone()
    ;(snapshot.status as any).cycle.alerts.futureSafetyAlert = true
    expect(captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected)).code).toBe(
      'PRODUCTION_CONTRACT_VIOLATION',
    )
  })

  test('rejects raw broker identity fields without leaking the value', () => {
    const snapshot = clone()
    ;(snapshot.status as any).broker.accountId = 'raw-broker-account-123'
    const failure = captureFailure(() => validateSnapshot(snapshot, expectedArgoRevision, expected))
    expect(failure.message).not.toContain('raw-broker-account-123')
    expect(failure.code).toBe('PRODUCTION_CONTRACT_VIOLATION')
  })
})

describe('bounded execution', () => {
  test('times out with the last precise blocker', async () => {
    let now = 0
    let attempts = 0
    const controller = new AbortController()
    await expect(
      retryVerification(
        async () => {
          attempts += 1
          throw new VerificationFailure('ARGO_NOT_CONVERGED', 'stale revision', true)
        },
        controller.signal,
        {
          deadlineMs: 25,
          intervalMs: 10,
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'VERIFICATION_TIMEOUT' })
    expect(attempts).toBe(3)
  })

  test('fails closed when interrupted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      retryVerification(async () => undefined, controller.signal, { deadlineMs: 100, intervalMs: 10 }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_INTERRUPTED' })
  })

  test('rejects an operation that reports success after the configured deadline', async () => {
    let now = 0
    const controller = new AbortController()
    await expect(
      runWithinDeadline(
        async () => {
          now = 11
        },
        controller.signal,
        10,
        () => now,
      ),
    ).rejects.toMatchObject({ code: 'VERIFICATION_TIMEOUT' })
  })

  test('cancels a stalled subprocess when the remaining deadline expires', async () => {
    const controller = new AbortController()
    const startedAt = Date.now()
    await expect(
      retryVerification(
        async (signal) => {
          await runCommand(
            ['bun', '-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => undefined, 1_000)"],
            signal,
          )
        },
        controller.signal,
        { deadlineMs: 50, intervalMs: 10 },
      ),
    ).rejects.toMatchObject({ code: 'VERIFICATION_TIMEOUT' })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  }, 2_000)
})

describe('Argo revision lineage', () => {
  test('accepts the exact promotion revision without Git reads', async () => {
    const controller = new AbortController()
    let calls = 0
    const run = async () => {
      calls += 1
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await expect(
      verifyArgoRevision(run, controller.signal, '/repo', expectedArgoRevision, expectedArgoRevision),
    ).resolves.toBeUndefined()
    expect(calls).toBe(0)
  })

  test('accepts a current-main descendant only when Bayn manifests are unchanged', async () => {
    const controller = new AbortController()
    const commands: readonly string[][] = [] as string[][]
    const run = async (command: readonly string[]) => {
      ;(commands as string[][]).push([...command])
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await expect(
      verifyArgoRevision(run, controller.signal, '/repo', expectedArgoRevision, descendantArgoRevision),
    ).resolves.toBeUndefined()
    expect(commands).toHaveLength(4)
    expect(commands[3]).toContain('argocd/applications/bayn/deployment.yaml')
    expect(commands[3]).toContain('argocd/applications/bayn/kustomization.yaml')
  })

  test('rejects a stale or divergent Argo revision', async () => {
    const controller = new AbortController()
    let call = 0
    const run = async () => {
      call += 1
      return { stdout: '', stderr: '', exitCode: call === 3 ? 1 : 0 }
    }
    await expect(
      verifyArgoRevision(run, controller.signal, '/repo', expectedArgoRevision, descendantArgoRevision),
    ).rejects.toMatchObject({ code: 'ARGO_NOT_CONVERGED' })
  })

  test('rejects a descendant that superseded the Bayn manifests', async () => {
    const controller = new AbortController()
    let call = 0
    const run = async () => {
      call += 1
      return { stdout: '', stderr: '', exitCode: call === 4 ? 1 : 0 }
    }
    await expect(
      verifyArgoRevision(run, controller.signal, '/repo', expectedArgoRevision, descendantArgoRevision),
    ).rejects.toMatchObject({ code: 'PRODUCTION_CONTRACT_VIOLATION' })
  })
})

describe('redaction and permissions', () => {
  test('redacts tokens, credentials, and raw account identities', () => {
    const redacted = redactSensitive(
      'Authorization: Bearer abc.def token=secret-value accountId=broker-123 password=hunter2',
    )
    expect(redacted).not.toContain('abc.def')
    expect(redacted).not.toContain('secret-value')
    expect(redacted).not.toContain('broker-123')
    expect(redacted).not.toContain('hunter2')
  })

  test('requires reads and rejects inherited write authority', async () => {
    const controller = new AbortController()
    const readOnly = async (command: readonly string[]) => {
      const allowedRead = ['get', 'list'].includes(command[3] ?? '') && command[4] !== 'secrets'
      return { stdout: allowedRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }
    await expect(validateReadOnlyPermissions(readOnly, controller.signal)).resolves.toBeUndefined()

    const writable = async () => ({ stdout: 'yes\n', stderr: '', exitCode: 0 })
    await expect(validateReadOnlyPermissions(writable, controller.signal)).rejects.toMatchObject({
      code: 'RBAC_DENIED',
    })
  })

  test('fails closed when a required read probe is indeterminate', async () => {
    const controller = new AbortController()
    let firstProbe = true
    const run = async (command: readonly string[]) => {
      if (firstProbe) {
        firstProbe = false
        return { stdout: 'yes\n', stderr: 'authorization warning\n', exitCode: 0 }
      }
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      const requiredRead = ['get', 'list'].includes(verb) && resource !== 'secrets'
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }

    await expect(validateReadOnlyPermissions(run, controller.signal)).rejects.toMatchObject({
      code: 'RBAC_DENIED',
    })
  })

  test.each([
    ['update', 'applications.argoproj.io', 'bayn'],
    ['patch', 'deployments.apps', 'bayn'],
    ['delete', 'services', 'bayn'],
    ['patch', 'endpoints', 'bayn'],
    ['get', 'secrets', 'bayn-alpaca-auth'],
    ['update', 'secrets', 'bayn-db-ca'],
  ])('rejects resourceNames-scoped %s authority for %s/%s', async (grantedVerb, grantedResource, grantedName) => {
    const controller = new AbortController()
    const run = async (command: readonly string[]) => {
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      const resourceNameAt = command.indexOf('--resource-name')
      const resourceName = resourceNameAt === -1 ? undefined : command[resourceNameAt + 1]
      if (verb === grantedVerb && resource === grantedResource && resourceName === grantedName) {
        return { stdout: 'yes\n', stderr: '', exitCode: 0 }
      }
      const requiredRead =
        (verb === 'get' && ['applications.argoproj.io', 'deployments.apps', 'services/proxy'].includes(resource)) ||
        (verb === 'list' && resource === 'pods')
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }

    await expect(validateReadOnlyPermissions(run, controller.signal, expected.secretNames)).rejects.toMatchObject({
      code: 'RBAC_DENIED',
    })
  })

  test('probes parent Service and endpoint-routing resources', async () => {
    const controller = new AbortController()
    const commands: string[][] = []
    const run = async (command: readonly string[]) => {
      commands.push([...command])
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      const requiredRead =
        (verb === 'get' && ['applications.argoproj.io', 'deployments.apps', 'services/proxy'].includes(resource)) ||
        (verb === 'list' && resource === 'pods')
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }

    await expect(validateReadOnlyPermissions(run, controller.signal, expected.secretNames)).resolves.toBeUndefined()
    for (const resource of ['services', 'services/status', 'endpoints', 'endpointslices.discovery.k8s.io']) {
      expect(commands.some((command) => command[4] === resource)).toBe(true)
    }
    expect(
      commands.some(
        (command) => command[4] === 'services' && command.includes('--resource-name') && command.includes('bayn'),
      ),
    ).toBe(true)
  })

  test('fails closed on resourceNames-scoped mutation exposed by the full rules audit', async () => {
    const controller = new AbortController()
    const readOnlyRules = [
      'selfsubjectaccessreviews.authorization.k8s.io [] [] [create]',
      'deployments.apps [] [] [get list watch]',
    ].join('\n')
    const run = async (command: readonly string[]) => {
      if (command.includes('--list')) {
        const namespace = command[command.indexOf('-n') + 1]
        return {
          stdout:
            namespace === 'bayn'
              ? `${readOnlyRules}\nendpointslices.discovery.k8s.io [] [bayn-abcde] [patch]\n`
              : `${readOnlyRules}\n`,
          stderr: '',
          exitCode: 0,
        }
      }
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      const requiredRead =
        (verb === 'get' && ['applications.argoproj.io', 'deployments.apps', 'services/proxy'].includes(resource)) ||
        (verb === 'list' && resource === 'pods')
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }

    await expect(
      validateProductionReadOnlyPermissions(run, controller.signal, expected.secretNames),
    ).rejects.toMatchObject({ code: 'RBAC_DENIED' })
  })

  test.each([
    ['broad', 'secrets [] [] [get]'],
    ['resourceNames-scoped', 'secrets [] [operator-created-secret] [get]'],
    ['wildcard resource', '* [] [operator-created-secret] [get]'],
    ['API-group wildcard resource', '*.* [] [operator-created-secret] [get]'],
    ['combined resource', 'configmaps,secrets [] [operator-created-secret] [get]'],
  ])('rejects %s Secret disclosure in the full rules audit', async (_name, secretRule) => {
    const controller = new AbortController()
    const run = async (command: readonly string[]) => {
      if (command.includes('--list')) {
        return {
          stdout: `${readOnlyAuthorizationRules}\n${secretRule}\n`,
          stderr: '',
          exitCode: 0,
        }
      }
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      const requiredRead =
        (verb === 'get' && ['applications.argoproj.io', 'deployments.apps', 'services/proxy'].includes(resource)) ||
        (verb === 'list' && resource === 'pods')
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }

    await expect(
      validateProductionReadOnlyPermissions(run, controller.signal, expected.secretNames),
    ).rejects.toMatchObject({ code: 'RBAC_DENIED' })
  })

  test('accepts only read-only namespace rule inventories plus self-review creation', async () => {
    const controller = new AbortController()
    const run = async (command: readonly string[]) => {
      if (command.includes('--list')) {
        return {
          stdout: [
            'selfsubjectreviews.authentication.k8s.io [] [] [create]',
            'selfsubjectaccessreviews.authorization.k8s.io [] [] [create]',
            'selfsubjectrulesreviews.authorization.k8s.io [] [] [create]',
            'deployments.apps [] [] [get list watch]',
            '                                                              [/healthz] [] [get]',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }
      }
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      const requiredRead =
        (verb === 'get' && ['applications.argoproj.io', 'deployments.apps', 'services/proxy'].includes(resource)) ||
        (verb === 'list' && resource === 'pods')
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }

    await expect(
      validateProductionReadOnlyPermissions(run, controller.signal, expected.secretNames),
    ).resolves.toBeUndefined()
  })

  test.each([
    ['API failure', { stdout: 'no\n', stderr: 'server unavailable\n', exitCode: 1 }],
    ['unexpected output', { stdout: 'unknown\n', stderr: '', exitCode: 0 }],
    ['stderr with no decision', { stdout: 'no\n', stderr: 'warning\n', exitCode: 0 }],
  ])('fails closed when a forbidden write probe is indeterminate: %s', async (_name, indeterminate) => {
    const controller = new AbortController()
    let forbiddenProbeSeen = false
    const run = async (command: readonly string[]) => {
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      const requiredRead = ['get', 'list'].includes(verb) && resource !== 'secrets'
      if (requiredRead) return { stdout: 'yes\n', stderr: '', exitCode: 0 }
      if (!forbiddenProbeSeen) {
        forbiddenProbeSeen = true
        return indeterminate
      }
      return { stdout: 'no\n', stderr: '', exitCode: 0 }
    }
    await expect(validateReadOnlyPermissions(run, controller.signal)).rejects.toMatchObject({
      code: 'RBAC_DENIED',
    })
  })

  test('fails closed when the forbidden secret-read probe is indeterminate', async () => {
    const controller = new AbortController()
    const run = async (command: readonly string[]) => {
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      if (resource === 'secrets') return { stdout: '', stderr: 'authorization API unavailable\n', exitCode: 1 }
      const requiredRead = ['get', 'list'].includes(verb)
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }
    await expect(validateReadOnlyPermissions(run, controller.signal)).rejects.toMatchObject({
      code: 'RBAC_DENIED',
    })
  })

  test.each(['get', 'list', 'watch'])('rejects %s access to Secrets', async (grantedVerb) => {
    const controller = new AbortController()
    const run = async (command: readonly string[]) => {
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      if (resource === 'secrets') {
        return { stdout: verb === grantedVerb ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
      }
      const requiredRead = ['get', 'list'].includes(verb)
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }

    await expect(validateReadOnlyPermissions(run, controller.signal)).rejects.toMatchObject({
      code: 'RBAC_DENIED',
    })
  })

  test.each(['create', 'update', 'patch', 'delete', 'deletecollection'])(
    'rejects %s write access to Secrets',
    async (grantedVerb) => {
      const controller = new AbortController()
      const run = async (command: readonly string[]) => {
        const verb = command[3] ?? ''
        const resource = command[4] ?? ''
        if (resource === 'secrets') {
          return { stdout: verb === grantedVerb ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
        }
        const requiredRead = ['get', 'list'].includes(verb)
        return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
      }

      await expect(validateReadOnlyPermissions(run, controller.signal)).rejects.toMatchObject({
        code: 'RBAC_DENIED',
      })
    },
  )

  test('rejects deletecollection authority independently of delete', async () => {
    const controller = new AbortController()
    const run = async (command: readonly string[]) => {
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      if (resource === 'secrets') return { stdout: 'no\n', stderr: '', exitCode: 0 }
      if (verb === 'deletecollection') return { stdout: 'yes\n', stderr: '', exitCode: 0 }
      const requiredRead = ['get', 'list'].includes(verb)
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }

    await expect(validateReadOnlyPermissions(run, controller.signal)).rejects.toMatchObject({
      code: 'RBAC_DENIED',
    })
  })

  test.each([
    ['create', 'services/proxy'],
    ['update', 'deployments.apps/scale'],
    ['create', 'pods/eviction'],
  ])('rejects %s authority on destructive subresource %s', async (grantedVerb, grantedResource) => {
    const controller = new AbortController()
    const run = async (command: readonly string[]) => {
      const verb = command[3] ?? ''
      const resource = command[4] ?? ''
      if (resource === 'secrets') return { stdout: 'no\n', stderr: '', exitCode: 0 }
      if (verb === grantedVerb && resource === grantedResource) {
        return { stdout: 'yes\n', stderr: '', exitCode: 0 }
      }
      const requiredRead = ['get', 'list'].includes(verb)
      return { stdout: requiredRead ? 'yes\n' : 'no\n', stderr: '', exitCode: 0 }
    }

    await expect(validateReadOnlyPermissions(run, controller.signal)).rejects.toMatchObject({
      code: 'RBAC_DENIED',
    })
  })

  test('workflow is main-only, path-scoped, and GitHub read-only', async () => {
    const workflow = await readFile(
      join(import.meta.dir, '..', '.github/workflows/bayn-post-deploy-verify.yml'),
      'utf8',
    )
    expect(workflow).toContain("- 'argocd/applications/bayn/deployment.yaml'")
    expect(workflow).toContain("- 'argocd/applications/bayn/kustomization.yaml'")
    expect(workflow).not.toContain('workflow_dispatch:')
    expect(workflow).toContain('permissions:\n      contents: read')
    expect(workflow).not.toMatch(/contents:\s*write/)
    expect(workflow).not.toMatch(/pull-requests:\s*write/)
    expect(workflow).not.toMatch(/kubectl\s+(apply|create|delete|patch|replace|rollout|set)/)
    expect(workflow).toContain('bun scripts/bayn-post-deploy-verify.ts')
  })

  test('Bayn CI detects, formats, lints, typechecks, and executes the verifier suite', async () => {
    const workflow = await readFile(join(import.meta.dir, '..', '.github/workflows/bayn-ci.yml'), 'utf8')
    expect(workflow).toContain('scripts/bayn-post-deploy-verify.ts')
    expect(workflow).toContain('scripts/bayn-post-deploy-verify.test.ts')
    expect(workflow).toContain('bunx oxfmt --check')
    expect(workflow).toContain('bunx oxlint --config .oxlintrc.json')
    expect(workflow).toContain('bun node_modules/typescript/bin/tsc --ignoreConfig --noEmit')
    expect(workflow).toContain('bun test packages/scripts/src/bayn scripts/bayn-post-deploy-verify.test.ts')
  })
})
