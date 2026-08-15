#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import process from 'node:process'

const baynRepository = 'registry.ide-newton.ts.net/lab/bayn'
const sha40 = /^[0-9a-f]{40}$/
const sha256 = /^sha256:[0-9a-f]{64}$/

type JsonRecord = Record<string, unknown>

export interface BaynExpectedDeploymentPins {
  readonly sourceRevision: string
  readonly imageDigest: string
  readonly imageTag: string
  readonly imageRepository: string
  readonly lifecycleOwner: string
  readonly brokerAccess: string
  readonly capitalAuthority: string
  readonly executionControllerPlanHash: string
}

export interface BaynPostDeployEvidenceInput {
  readonly deploymentManifest: string
  readonly kustomization: string
  readonly deployment: unknown
  readonly pods: unknown
  readonly readyzStatusCode: number
  readonly readyz: unknown
  readonly statusStatusCode: number
  readonly status: unknown
}

export interface BaynPostDeployEvidenceResult {
  readonly sourceRevision: string
  readonly imageDigest: string
  readonly podName: string
  readonly probeSequence: number
  readonly cycleCondition: string
  readonly controllerEpoch: number
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown, context: string): JsonRecord => {
  if (!isRecord(value)) throw new Error(`${context} must be an object`)
  return value
}

const array = (value: unknown, context: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`)
  return value
}

const string = (value: unknown, context: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${context} must be a non-empty string`)
  return value
}

const integer = (value: unknown, context: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${context} must be a safe integer`)
  return value
}

const optionalInteger = (value: unknown, context: string): number => (value === undefined ? 0 : integer(value, context))

const utcInstant = (value: unknown, context: string): string => {
  const candidate = string(value, context)
  if (!Number.isFinite(Date.parse(candidate))) throw new Error(`${context} must be a valid timestamp`)
  return candidate
}

const expectEqual = (actual: unknown, expected: unknown, context: string): void => {
  if (actual !== expected)
    throw new Error(`${context} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const yamlScalar = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('"')) return trimmed
  const decoded: unknown = JSON.parse(trimmed)
  return string(decoded, 'YAML scalar')
}

const manifestEnvironmentValue = (deployment: string, name: string): string => {
  const pattern = new RegExp(`            - name: ${name}\\n              value: ([^\\n]+)\\n`, 'g')
  const matches = [...deployment.matchAll(pattern)]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`expected exactly one source-controlled ${name} value`)
  }
  return yamlScalar(matches[0][1])
}

const parseKustomizationImage = (kustomization: string) => {
  const pattern = /  - name: bayn-main\n    newName: ([^\n]+)\n    newTag: ([^\n]+)\n    digest: ([^\n]+)\n/g
  const matches = [...kustomization.matchAll(pattern)]
  if (
    matches.length !== 1 ||
    matches[0]?.[1] === undefined ||
    matches[0]?.[2] === undefined ||
    matches[0]?.[3] === undefined
  ) {
    throw new Error('expected exactly one source-controlled bayn-main image block')
  }
  return {
    repository: yamlScalar(matches[0][1]),
    tag: yamlScalar(matches[0][2]),
    digest: yamlScalar(matches[0][3]),
  }
}

export const parseBaynExpectedDeploymentPins = (
  deploymentManifest: string,
  kustomization: string,
): BaynExpectedDeploymentPins => {
  const sourceRevision = manifestEnvironmentValue(deploymentManifest, 'BAYN_CODE_REVISION')
  const imageDigest = manifestEnvironmentValue(deploymentManifest, 'BAYN_IMAGE_DIGEST')
  const imageRepository = manifestEnvironmentValue(deploymentManifest, 'BAYN_IMAGE_REPOSITORY')
  const lifecycleOwner = manifestEnvironmentValue(deploymentManifest, 'BAYN_LIFECYCLE_OWNER')
  const brokerAccess = manifestEnvironmentValue(deploymentManifest, 'BAYN_BROKER_ACCESS')
  const capitalAuthority = manifestEnvironmentValue(deploymentManifest, 'BAYN_CAPITAL_AUTHORITY')
  const executionControllerPlanHash = manifestEnvironmentValue(
    deploymentManifest,
    'BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH',
  )
  const image = parseKustomizationImage(kustomization)

  if (!sha40.test(sourceRevision)) throw new Error(`invalid BAYN_CODE_REVISION ${sourceRevision}`)
  if (!sha256.test(imageDigest)) throw new Error(`invalid BAYN_IMAGE_DIGEST ${imageDigest}`)
  if (!/^[0-9a-f]{64}$/.test(executionControllerPlanHash)) {
    throw new Error(`invalid BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH ${executionControllerPlanHash}`)
  }
  if (imageRepository !== baynRepository || image.repository !== baynRepository) {
    throw new Error('Bayn source-controlled image repository is inconsistent')
  }
  if (image.tag !== `sha-${sourceRevision}`) {
    throw new Error(`Bayn image tag ${image.tag} does not bind source revision ${sourceRevision}`)
  }
  if (image.digest !== imageDigest) throw new Error('Bayn kustomization digest does not match BAYN_IMAGE_DIGEST')
  if (lifecycleOwner !== 'RESTATE') throw new Error(`Bayn lifecycle owner must remain RESTATE, got ${lifecycleOwner}`)
  if (brokerAccess !== 'read-only') throw new Error(`Bayn broker access must remain read-only, got ${brokerAccess}`)
  if (capitalAuthority !== 'none') throw new Error(`Bayn capital authority must remain none, got ${capitalAuthority}`)

  return {
    sourceRevision,
    imageDigest,
    imageTag: image.tag,
    imageRepository,
    lifecycleOwner,
    brokerAccess,
    capitalAuthority,
    executionControllerPlanHash,
  }
}

const environmentMap = (container: JsonRecord, context: string): ReadonlyMap<string, string> => {
  const entries = array(container.env ?? [], `${context}.env`)
  const mapped = new Map<string, string>()
  for (const entry of entries) {
    const env = record(entry, `${context}.env[]`)
    const name = string(env.name, `${context}.env[].name`)
    if (mapped.has(name)) throw new Error(`${context} contains duplicate environment variable ${name}`)
    if (typeof env.value === 'string') mapped.set(name, env.value)
  }
  return mapped
}

const containerByName = (containers: readonly unknown[], name: string, context: string): JsonRecord => {
  const matches = containers
    .map((candidate) => record(candidate, `${context}[]`))
    .filter((candidate) => candidate.name === name)
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error(`${context} must contain exactly one ${name} container`)
  return matches[0]
}

const assertImageReference = (image: string, expected: BaynExpectedDeploymentPins, context: string): void => {
  if (!image.startsWith(`${expected.imageRepository}:sha-${expected.sourceRevision}@`)) {
    throw new Error(`${context} does not bind the expected source tag: ${image}`)
  }
  if (!image.endsWith(`@${expected.imageDigest}`)) {
    throw new Error(`${context} does not bind the expected digest: ${image}`)
  }
}

const validateDeployment = (candidate: unknown, expected: BaynExpectedDeploymentPins): string => {
  const deployment = record(candidate, 'deployment')
  const metadata = record(deployment.metadata, 'deployment.metadata')
  const spec = record(deployment.spec, 'deployment.spec')
  const status = record(deployment.status, 'deployment.status')
  const template = record(spec.template, 'deployment.spec.template')
  const podSpec = record(template.spec, 'deployment.spec.template.spec')

  expectEqual(metadata.name, 'bayn', 'deployment.metadata.name')
  expectEqual(metadata.namespace, 'bayn', 'deployment.metadata.namespace')
  expectEqual(spec.replicas, 1, 'deployment.spec.replicas')
  expectEqual(status.observedGeneration, metadata.generation, 'deployment.status.observedGeneration')
  expectEqual(
    optionalInteger(status.updatedReplicas, 'deployment.status.updatedReplicas'),
    1,
    'deployment.status.updatedReplicas',
  )
  expectEqual(
    optionalInteger(status.readyReplicas, 'deployment.status.readyReplicas'),
    1,
    'deployment.status.readyReplicas',
  )
  expectEqual(
    optionalInteger(status.availableReplicas, 'deployment.status.availableReplicas'),
    1,
    'deployment.status.availableReplicas',
  )
  expectEqual(
    optionalInteger(status.unavailableReplicas, 'deployment.status.unavailableReplicas'),
    0,
    'deployment.status.unavailableReplicas',
  )

  const bayn = containerByName(
    array(podSpec.containers, 'deployment.spec.template.spec.containers'),
    'bayn',
    'deployment containers',
  )
  const image = string(bayn.image, 'deployment bayn image')
  assertImageReference(image, expected, 'deployment bayn image')
  const env = environmentMap(bayn, 'deployment bayn container')
  const expectedEnvironment = new Map<string, string>([
    ['BAYN_CODE_REVISION', expected.sourceRevision],
    ['BAYN_IMAGE_REPOSITORY', expected.imageRepository],
    ['BAYN_IMAGE_DIGEST', expected.imageDigest],
    ['BAYN_LIFECYCLE_OWNER', expected.lifecycleOwner],
    ['BAYN_BROKER_ACCESS', expected.brokerAccess],
    ['BAYN_CAPITAL_AUTHORITY', expected.capitalAuthority],
    ['BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH', expected.executionControllerPlanHash],
  ])
  for (const [name, value] of expectedEnvironment) {
    expectEqual(env.get(name), value, `deployment ${name}`)
  }
  return image
}

const validatePods = (candidate: unknown, expected: BaynExpectedDeploymentPins, deploymentImage: string): string => {
  const pods = record(candidate, 'pods')
  const activePods = array(pods.items, 'pods.items')
    .map((item) => record(item, 'pods.items[]'))
    .filter((pod) => record(pod.metadata, 'pod.metadata').deletionTimestamp === undefined)
  if (activePods.length !== 1 || activePods[0] === undefined) {
    throw new Error(`expected exactly one active Bayn pod, got ${activePods.length}`)
  }
  const pod = activePods[0]
  const metadata = record(pod.metadata, 'pod.metadata')
  const spec = record(pod.spec, 'pod.spec')
  const status = record(pod.status, 'pod.status')
  const podName = string(metadata.name, 'pod.metadata.name')
  expectEqual(status.phase, 'Running', `${podName} phase`)
  const container = containerByName(
    array(spec.containers, `${podName}.spec.containers`),
    'bayn',
    `${podName} containers`,
  )
  const containerStatus = containerByName(
    array(status.containerStatuses, `${podName}.status.containerStatuses`),
    'bayn',
    `${podName} container statuses`,
  )
  expectEqual(container.image, deploymentImage, `${podName} image`)
  expectEqual(containerStatus.ready, true, `${podName} ready`)
  expectEqual(containerStatus.restartCount, 0, `${podName} restartCount`)
  const imageId = string(containerStatus.imageID, `${podName} imageID`)
  if (!imageId.endsWith(`@${expected.imageDigest}`)) {
    throw new Error(`${podName} imageID does not bind expected digest: ${imageId}`)
  }
  return podName
}

const validateReadyz = (statusCode: number, candidate: unknown): number => {
  expectEqual(statusCode, 200, 'Bayn /readyz HTTP status')
  const readyz = record(candidate, 'readyz')
  expectEqual(readyz.ready, true, 'readyz.ready')
  expectEqual(readyz.status, 'READY', 'readyz.status')
  utcInstant(readyz.checkedAt, 'readyz.checkedAt')
  const sequence = integer(readyz.probeSequence, 'readyz.probeSequence')
  if (sequence <= 0) throw new Error('readyz.probeSequence must be positive')
  const failures = array(readyz.failedDependencies, 'readyz.failedDependencies')
  if (failures.length !== 0) throw new Error(`readyz.failedDependencies must be empty, got ${JSON.stringify(failures)}`)
  return sequence
}

const validateStatus = (
  statusCode: number,
  candidate: unknown,
  expected: BaynExpectedDeploymentPins,
  minimumProbeSequence: number,
): { readonly cycleCondition: string; readonly controllerEpoch: number } => {
  expectEqual(statusCode, 200, 'Bayn /v1/status HTTP status')
  const status = record(candidate, 'status')
  expectEqual(status.service, 'bayn', 'status.service')
  const operational = record(status.operational, 'status.operational')
  expectEqual(operational.ready, true, 'status.operational.ready')
  expectEqual(operational.status, 'READY', 'status.operational.status')
  utcInstant(operational.checkedAt, 'status.operational.checkedAt')
  if (integer(operational.probeSequence, 'status.operational.probeSequence') < minimumProbeSequence) {
    throw new Error('status.operational.probeSequence must not predate the readyz observation')
  }

  const dependencies = record(status.dependencies, 'status.dependencies')
  const dependencyEntries = Object.entries(dependencies)
  if (dependencyEntries.length === 0) throw new Error('status.dependencies must not be empty')
  for (const [name, value] of dependencyEntries) {
    const dependency = record(value, `status.dependencies.${name}`)
    expectEqual(dependency.status, 'AVAILABLE', `status.dependencies.${name}.status`)
  }

  const broker = record(status.broker, 'status.broker')
  expectEqual(broker.configured, true, 'status.broker.configured')
  expectEqual(broker.accountBound, true, 'status.broker.accountBound')
  expectEqual(broker.readAvailable, true, 'status.broker.readAvailable')
  expectEqual(broker.reasonCode, null, 'status.broker.reasonCode')
  expectEqual(broker.error, null, 'status.broker.error')

  const cycle = record(status.cycle, 'status.cycle')
  expectEqual(cycle.observationAvailable, true, 'status.cycle.observationAvailable')
  const cycleCondition = string(cycle.condition, 'status.cycle.condition')
  if (cycleCondition !== 'WAITING' && cycleCondition !== 'RUNNING') {
    throw new Error(`status.cycle.condition must be WAITING or RUNNING, got ${cycleCondition}`)
  }
  expectEqual(cycle.zeroMutation, true, 'status.cycle.zeroMutation')

  const loop = record(status.autonomousCycleLoop, 'status.autonomousCycleLoop')
  expectEqual(loop.configured, true, 'status.autonomousCycleLoop.configured')
  expectEqual(loop.owner, 'Restate', 'status.autonomousCycleLoop.owner')

  const controller = record(status.executionController, 'status.executionController')
  expectEqual(controller.configured, true, 'status.executionController.configured')
  expectEqual(controller.readAvailable, true, 'status.executionController.readAvailable')
  expectEqual(controller.reasonCode, null, 'status.executionController.reasonCode')
  const controllerStatus = record(controller.status, 'status.executionController.status')
  expectEqual(controllerStatus.active, true, 'status.executionController.status.active')
  expectEqual(
    controllerStatus.planHash,
    expected.executionControllerPlanHash,
    'status.executionController.status.planHash',
  )
  const controllerEpoch = integer(controllerStatus.epoch, 'status.executionController.status.epoch')
  if (controllerEpoch < 0) throw new Error('status.executionController.status.epoch must be non-negative')

  const activation = record(status.capitalActivation, 'status.capitalActivation')
  expectEqual(activation._tag, 'NotConfigured', 'status.capitalActivation._tag')

  const authority = record(status.authority, 'status.authority')
  expectEqual(authority.brokerEnvironment, 'sandbox', 'status.authority.brokerEnvironment')
  expectEqual(authority.brokerAccess, expected.brokerAccess, 'status.authority.brokerAccess')
  expectEqual(authority.capitalAuthority, expected.capitalAuthority, 'status.authority.capitalAuthority')
  expectEqual(authority.brokerOrders, false, 'status.authority.brokerOrders')
  expectEqual(authority.capitalPromotion, false, 'status.authority.capitalPromotion')
  const durable = record(authority.durable, 'status.authority.durable')
  expectEqual(durable.available, true, 'status.authority.durable.available')

  const build = record(status.build, 'status.build')
  expectEqual(build.sourceRevision, expected.sourceRevision, 'status.build.sourceRevision')
  expectEqual(build.verification, 'embedded', 'status.build.verification')
  const image = record(build.image, 'status.build.image')
  expectEqual(image.repository, expected.imageRepository, 'status.build.image.repository')
  expectEqual(image.digest, expected.imageDigest, 'status.build.image.digest')
  expectEqual(status.error, null, 'status.error')

  return { cycleCondition, controllerEpoch }
}

export const validateBaynPostDeployEvidence = (input: BaynPostDeployEvidenceInput): BaynPostDeployEvidenceResult => {
  const expected = parseBaynExpectedDeploymentPins(input.deploymentManifest, input.kustomization)
  const deploymentImage = validateDeployment(input.deployment, expected)
  const podName = validatePods(input.pods, expected, deploymentImage)
  const probeSequence = validateReadyz(input.readyzStatusCode, input.readyz)
  const runtime = validateStatus(input.statusStatusCode, input.status, expected, probeSequence)
  return {
    sourceRevision: expected.sourceRevision,
    imageDigest: expected.imageDigest,
    podName,
    probeSequence,
    cycleCondition: runtime.cycleCondition,
    controllerEpoch: runtime.controllerEpoch,
  }
}

const requiredEnv = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown

if (import.meta.main) {
  try {
    const result = validateBaynPostDeployEvidence({
      deploymentManifest: readFileSync(requiredEnv('BAYN_POST_DEPLOY_DEPLOYMENT_MANIFEST'), 'utf8'),
      kustomization: readFileSync(requiredEnv('BAYN_POST_DEPLOY_KUSTOMIZATION'), 'utf8'),
      deployment: readJson(requiredEnv('BAYN_POST_DEPLOY_DEPLOYMENT_JSON')),
      pods: readJson(requiredEnv('BAYN_POST_DEPLOY_PODS_JSON')),
      readyzStatusCode: Number(requiredEnv('BAYN_POST_DEPLOY_READYZ_HTTP_STATUS')),
      readyz: readJson(requiredEnv('BAYN_POST_DEPLOY_READYZ_JSON')),
      statusStatusCode: Number(requiredEnv('BAYN_POST_DEPLOY_STATUS_HTTP_STATUS')),
      status: readJson(requiredEnv('BAYN_POST_DEPLOY_STATUS_JSON')),
    })
    console.log(JSON.stringify({ status: 'verified', ...result }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
