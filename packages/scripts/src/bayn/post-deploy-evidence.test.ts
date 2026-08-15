import { describe, expect, test } from 'bun:test'

import { validateBaynPostDeployEvidence } from './post-deploy-evidence'

const sourceRevision = 'a'.repeat(40)
const imageDigest = `sha256:${'b'.repeat(64)}`
const planHash = 'c'.repeat(64)
const image = `registry.ide-newton.ts.net/lab/bayn:sha-${sourceRevision}@${imageDigest}`

const deploymentManifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: bayn
spec:
  template:
    spec:
      containers:
        - name: bayn
          env:
            - name: BAYN_CODE_REVISION
              value: ${sourceRevision}
            - name: BAYN_LIFECYCLE_OWNER
              value: RESTATE
            - name: BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH
              value: "${planHash}"
            - name: BAYN_IMAGE_REPOSITORY
              value: registry.ide-newton.ts.net/lab/bayn
            - name: BAYN_IMAGE_DIGEST
              value: ${imageDigest}
            - name: BAYN_BROKER_ACCESS
              value: read-only
            - name: BAYN_CAPITAL_AUTHORITY
              value: none
`

const kustomization = `images:
  - name: bayn-main
    newName: registry.ide-newton.ts.net/lab/bayn
    newTag: sha-${sourceRevision}
    digest: ${imageDigest}
`

const deployment = {
  metadata: { name: 'bayn', namespace: 'bayn', generation: 12 },
  spec: {
    replicas: 1,
    template: {
      spec: {
        containers: [
          {
            name: 'bayn',
            image,
            env: [
              { name: 'BAYN_CODE_REVISION', value: sourceRevision },
              { name: 'BAYN_LIFECYCLE_OWNER', value: 'RESTATE' },
              { name: 'BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH', value: planHash },
              { name: 'BAYN_IMAGE_REPOSITORY', value: 'registry.ide-newton.ts.net/lab/bayn' },
              { name: 'BAYN_IMAGE_DIGEST', value: imageDigest },
              { name: 'BAYN_BROKER_ACCESS', value: 'read-only' },
              { name: 'BAYN_CAPITAL_AUTHORITY', value: 'none' },
            ],
          },
        ],
      },
    },
  },
  status: { observedGeneration: 12, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
}

const pods = {
  items: [
    {
      metadata: { name: 'bayn-abc' },
      spec: { containers: [{ name: 'bayn', image }] },
      status: {
        phase: 'Running',
        containerStatuses: [
          { name: 'bayn', ready: true, restartCount: 0, imageID: `registry.ide-newton.ts.net/lab/bayn@${imageDigest}` },
        ],
      },
    },
  ],
}

const readyz = {
  ready: true,
  status: 'READY',
  checkedAt: '2026-08-15T07:00:00.000Z',
  probeSequence: 8,
  failedDependencies: [] as string[],
}

const dependencies = Object.fromEntries(
  ['postgresql', 'signal', 'tigerBeetle', 'evidence', 'cycle', 'cycleRunner'].map((name) => [
    name,
    { status: 'AVAILABLE', checkedAt: '2026-08-15T07:00:00.000Z', error: null },
  ]),
)

const status = {
  service: 'bayn',
  operational: { ready: true, status: 'READY', checkedAt: '2026-08-15T07:00:01.000Z', probeSequence: 9 },
  dependencies,
  broker: { configured: true, accountBound: true, readAvailable: true, reasonCode: null, error: null },
  cycle: { observationAvailable: true, condition: 'WAITING', zeroMutation: true },
  autonomousCycleLoop: { configured: true, owner: 'Restate' },
  executionController: {
    configured: true,
    readAvailable: true,
    reasonCode: null,
    status: { active: true, planHash, epoch: 7 },
  },
  capitalActivation: { _tag: 'NotConfigured' },
  authority: {
    brokerEnvironment: 'sandbox',
    brokerAccess: 'read-only',
    capitalAuthority: 'none',
    durable: { available: true },
    brokerOrders: false,
    capitalPromotion: false,
  },
  build: {
    sourceRevision,
    image: { repository: 'registry.ide-newton.ts.net/lab/bayn', digest: imageDigest },
    verification: 'embedded',
  },
  error: null,
}

const evidence = () => ({
  deploymentManifest,
  kustomization,
  deployment: structuredClone(deployment),
  pods: structuredClone(pods),
  readyzStatusCode: 200,
  readyz: structuredClone(readyz),
  statusStatusCode: 200,
  status: structuredClone(status),
})

describe('Bayn post-deploy evidence', () => {
  test('accepts one exact healthy read-only native Restate deployment', () => {
    expect(validateBaynPostDeployEvidence(evidence())).toEqual({
      sourceRevision,
      imageDigest,
      podName: 'bayn-abc',
      podRestartCount: 0,
      probeSequence: 8,
      cycleCondition: 'WAITING',
      controllerEpoch: 7,
    })
  })

  test('records historical pod restarts without rejecting a currently healthy deployment', () => {
    const input = evidence()
    input.pods.items[0]!.status.containerStatuses[0]!.restartCount = 3

    expect(validateBaynPostDeployEvidence(input)).toMatchObject({
      podName: 'bayn-abc',
      podRestartCount: 3,
    })
  })

  test('rejects the exact Synced-but-not-ready production failure class', () => {
    const input = evidence()
    input.deployment.status.readyReplicas = 0
    input.deployment.status.availableReplicas = 0
    expect(() => validateBaynPostDeployEvidence(input)).toThrow('deployment.status.readyReplicas must be 1')
  })

  test('rejects runtime readiness drift even when Kubernetes reports one ready replica', () => {
    const input = evidence()
    input.readyzStatusCode = 503
    input.readyz.ready = false
    input.readyz.status = 'STARTING'
    input.readyz.failedDependencies = ['cycle']
    expect(() => validateBaynPostDeployEvidence(input)).toThrow('Bayn /readyz HTTP status must be 200')
  })

  test('rejects missing cycle evidence and a fail-open broker authority widening', () => {
    const cycleInput = evidence()
    cycleInput.status.cycle.observationAvailable = false
    cycleInput.status.cycle.condition = 'UNKNOWN'
    expect(() => validateBaynPostDeployEvidence(cycleInput)).toThrow('status.cycle.observationAvailable must be true')

    const authorityInput = evidence()
    authorityInput.status.authority.brokerAccess = 'mutation'
    expect(() => validateBaynPostDeployEvidence(authorityInput)).toThrow(
      'status.authority.brokerAccess must be "read-only"',
    )
  })

  test('rejects stale code, image, controller, and pod runtime identity', () => {
    const codeInput = evidence()
    codeInput.status.build.sourceRevision = 'd'.repeat(40)
    expect(() => validateBaynPostDeployEvidence(codeInput)).toThrow('status.build.sourceRevision')

    const imageInput = evidence()
    imageInput.pods.items[0]!.status.containerStatuses[0]!.imageID = `registry.ide-newton.ts.net/lab/bayn@sha256:${'d'.repeat(64)}`
    expect(() => validateBaynPostDeployEvidence(imageInput)).toThrow('imageID does not bind expected digest')

    const controllerInput = evidence()
    controllerInput.status.executionController.status.planHash = 'd'.repeat(64)
    expect(() => validateBaynPostDeployEvidence(controllerInput)).toThrow('status.executionController.status.planHash')
  })
})
