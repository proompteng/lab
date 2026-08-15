#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const sourcePattern = /^[0-9a-f]{40}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/
const hashPattern = /^[0-9a-f]{64}$/
const maximumClockSkewMs = 30_000
const defaultEvidenceAgeMs = 180_000

type JsonRecord = Record<string, unknown>

export type BaynPostDeployFailureCode =
  | 'INVALID_MANIFEST'
  | 'ARGO_NOT_CONVERGED'
  | 'WORKLOAD_NOT_CONVERGED'
  | 'RUNTIME_NOT_READY'
  | 'PRODUCTION_CONTRACT_VIOLATION'
  | 'READ_UNAVAILABLE'
  | 'REVISION_NOT_CONVERGED'
  | 'VERIFICATION_TIMEOUT'

export class BaynPostDeployFailure extends Error {
  constructor(
    readonly code: BaynPostDeployFailureCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${code}: ${message}`)
    this.name = 'BaynPostDeployFailure'
  }
}

export interface ExpectedBaynProduction {
  readonly sourceRevision: string
  readonly imageRepository: string
  readonly imageTag: string
  readonly imageDigest: string
  readonly imageReference: string
  readonly executionControllerPlanHash: string
  readonly authorityGenerationHash: string
}

export interface BaynPostDeploySnapshot {
  readonly application: unknown
  readonly restateApplications: unknown
  readonly deployment: unknown
  readonly executionController: unknown
  readonly readiness: unknown
  readonly status: unknown
  readonly metrics: string
}

const fail = (code: BaynPostDeployFailureCode, message: string, retryable: boolean): never => {
  throw new BaynPostDeployFailure(code, message, retryable)
}

const record = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('PRODUCTION_CONTRACT_VIOLATION', `${path} must be an object`, false)
  }
  return value as JsonRecord
}

const array = (value: unknown, path: string): readonly unknown[] => {
  if (!Array.isArray(value)) return fail('PRODUCTION_CONTRACT_VIOLATION', `${path} must be an array`, false)
  return value
}

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    return fail('PRODUCTION_CONTRACT_VIOLATION', `${path} must be a non-empty string`, false)
  }
  return value
}

const integer = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail('PRODUCTION_CONTRACT_VIOLATION', `${path} must be an integer`, false)
  }
  return value
}

const equal = (
  actual: unknown,
  expected: string | number | boolean | null,
  path: string,
  code: BaynPostDeployFailureCode,
  retryable: boolean,
): void => {
  if (actual !== expected) fail(code, `${path} did not match the required value`, retryable)
}

const parseYamlRecord = (source: string, path: string): JsonRecord => {
  try {
    return record(Bun.YAML.parse(source), path)
  } catch (error) {
    if (error instanceof BaynPostDeployFailure) throw error
    return fail('INVALID_MANIFEST', `${path} is not valid YAML`, false)
  }
}

const namedContainer = (containers: unknown, name: string, path: string): JsonRecord => {
  const matches = array(containers, path).filter((candidate) => {
    const item = record(candidate, `${path}[]`)
    return item.name === name
  })
  if (matches.length !== 1) {
    return fail('PRODUCTION_CONTRACT_VIOLATION', `${path} must contain exactly one ${name} container`, false)
  }
  return record(matches[0], `${path}.${name}`)
}

const environment = (container: JsonRecord, path: string): ReadonlyMap<string, string> => {
  const values = new Map<string, string>()
  for (const [index, candidate] of array(container.env, `${path}.env`).entries()) {
    const item = record(candidate, `${path}.env[${index}]`)
    const name = string(item.name, `${path}.env[${index}].name`)
    if (typeof item.value === 'string') values.set(name, item.value)
  }
  return values
}

const requiredEnv = (values: ReadonlyMap<string, string>, name: string, path: string): string => {
  const value = values.get(name)
  if (value === undefined) return fail('INVALID_MANIFEST', `${path} is missing ${name}`, false)
  return value
}

const firstContainer = (manifest: JsonRecord, name: string, path: string): JsonRecord => {
  const spec = record(manifest.spec, `${path}.spec`)
  const template = record(spec.template, `${path}.spec.template`)
  const podSpec = record(template.spec, `${path}.spec.template.spec`)
  return namedContainer(podSpec.containers, name, `${path}.spec.template.spec.containers`)
}

export const parseExpectedBaynProduction = (
  kustomizationSource: string,
  deploymentSource: string,
  executionControllerSource: string,
): ExpectedBaynProduction => {
  const kustomization = parseYamlRecord(kustomizationSource, 'kustomization')
  const images = array(kustomization.images, 'kustomization.images')
  const imageCandidates = images.filter((candidate) => record(candidate, 'kustomization.images[]').name === 'bayn-main')
  if (imageCandidates.length !== 1) {
    return fail('INVALID_MANIFEST', 'kustomization must contain exactly one bayn-main image', false)
  }
  const image = record(imageCandidates[0], 'kustomization.images.bayn-main')
  const imageRepository = string(image.newName, 'kustomization.images.bayn-main.newName')
  const imageTag = string(image.newTag, 'kustomization.images.bayn-main.newTag')
  const imageDigest = string(image.digest, 'kustomization.images.bayn-main.digest')
  if (!digestPattern.test(imageDigest)) return fail('INVALID_MANIFEST', 'Bayn image digest is not immutable', false)
  const tagMatch = /^sha-([0-9a-f]{40})$/.exec(imageTag)
  if (tagMatch?.[1] === undefined) return fail('INVALID_MANIFEST', 'Bayn image tag must bind a full source SHA', false)
  const sourceRevision = tagMatch[1]

  const deployment = parseYamlRecord(deploymentSource, 'deployment')
  const deploymentContainer = firstContainer(deployment, 'bayn', 'deployment')
  equal(deploymentContainer.image, 'bayn-main', 'deployment container image alias', 'INVALID_MANIFEST', false)
  const deploymentEnv = environment(deploymentContainer, 'deployment.container')
  equal(
    requiredEnv(deploymentEnv, 'BAYN_CODE_REVISION', 'deployment'),
    sourceRevision,
    'deployment source',
    'INVALID_MANIFEST',
    false,
  )
  equal(
    requiredEnv(deploymentEnv, 'BAYN_IMAGE_REPOSITORY', 'deployment'),
    imageRepository,
    'deployment image repository',
    'INVALID_MANIFEST',
    false,
  )
  equal(
    requiredEnv(deploymentEnv, 'BAYN_IMAGE_DIGEST', 'deployment'),
    imageDigest,
    'deployment digest',
    'INVALID_MANIFEST',
    false,
  )
  equal(
    requiredEnv(deploymentEnv, 'BAYN_BROKER_ACCESS', 'deployment'),
    'read-only',
    'deployment broker access',
    'INVALID_MANIFEST',
    false,
  )
  equal(
    requiredEnv(deploymentEnv, 'BAYN_CAPITAL_AUTHORITY', 'deployment'),
    'none',
    'deployment capital authority',
    'INVALID_MANIFEST',
    false,
  )
  const executionControllerPlanHash = requiredEnv(
    deploymentEnv,
    'BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH',
    'deployment',
  )
  const authorityGenerationHash = requiredEnv(deploymentEnv, 'BAYN_AUTHORITY_GENERATION_HASH', 'deployment')
  if (!hashPattern.test(executionControllerPlanHash)) {
    return fail('INVALID_MANIFEST', 'expected execution-controller plan hash is invalid', false)
  }
  if (!hashPattern.test(authorityGenerationHash)) {
    return fail('INVALID_MANIFEST', 'authority generation hash is invalid', false)
  }

  const executionController = parseYamlRecord(executionControllerSource, 'executionController')
  equal(executionController.kind, 'RestateDeployment', 'executionController.kind', 'INVALID_MANIFEST', false)
  const controllerContainer = firstContainer(executionController, 'execution-controller', 'executionController')
  const imageReference = `${imageRepository}:${imageTag}@${imageDigest}`
  equal(controllerContainer.image, imageReference, 'execution-controller image', 'INVALID_MANIFEST', false)
  const controllerEnv = environment(controllerContainer, 'executionController.container')
  equal(
    requiredEnv(controllerEnv, 'BAYN_CODE_REVISION', 'executionController'),
    sourceRevision,
    'controller source',
    'INVALID_MANIFEST',
    false,
  )
  equal(
    requiredEnv(controllerEnv, 'BAYN_IMAGE_REPOSITORY', 'executionController'),
    imageRepository,
    'controller image repository',
    'INVALID_MANIFEST',
    false,
  )
  equal(
    requiredEnv(controllerEnv, 'BAYN_IMAGE_DIGEST', 'executionController'),
    imageDigest,
    'controller digest',
    'INVALID_MANIFEST',
    false,
  )
  equal(
    requiredEnv(controllerEnv, 'BAYN_BROKER_ACCESS', 'executionController'),
    'read-only',
    'controller broker access',
    'INVALID_MANIFEST',
    false,
  )
  equal(
    requiredEnv(controllerEnv, 'BAYN_CAPITAL_AUTHORITY', 'executionController'),
    'none',
    'controller capital authority',
    'INVALID_MANIFEST',
    false,
  )
  equal(
    requiredEnv(controllerEnv, 'BAYN_AUTHORITY_GENERATION_HASH', 'executionController'),
    authorityGenerationHash,
    'controller authority generation',
    'INVALID_MANIFEST',
    false,
  )

  return {
    sourceRevision,
    imageRepository,
    imageTag,
    imageDigest,
    imageReference,
    executionControllerPlanHash,
    authorityGenerationHash,
  }
}

const freshInstant = (value: unknown, path: string, nowMs: number, maximumAgeMs: number): void => {
  const instant = string(value, path)
  const observedAt = Date.parse(instant)
  if (!Number.isFinite(observedAt)) return fail('RUNTIME_NOT_READY', `${path} is not a valid instant`, true)
  if (observedAt > nowMs + maximumClockSkewMs) return fail('RUNTIME_NOT_READY', `${path} is in the future`, true)
  if (nowMs - observedAt >= maximumAgeMs) return fail('RUNTIME_NOT_READY', `${path} is stale`, true)
}

const optionalCount = (value: unknown, path: string): number => (value === undefined ? 0 : integer(value, path))

const validateArgo = (value: unknown): void => {
  const application = record(value, 'application')
  const metadata = record(application.metadata, 'application.metadata')
  equal(metadata.name, 'bayn', 'application.metadata.name', 'ARGO_NOT_CONVERGED', true)
  const spec = record(application.spec, 'application.spec')
  const source = record(spec.source, 'application.spec.source')
  equal(source.path, 'argocd/applications/bayn', 'application.spec.source.path', 'ARGO_NOT_CONVERGED', true)
  equal(
    source.repoURL,
    'https://github.com/proompteng/lab.git',
    'application.spec.source.repoURL',
    'ARGO_NOT_CONVERGED',
    true,
  )
  equal(source.targetRevision, 'main', 'application.spec.source.targetRevision', 'ARGO_NOT_CONVERGED', true)
  equal(
    record(spec.destination, 'application.spec.destination').namespace,
    'bayn',
    'application destination',
    'ARGO_NOT_CONVERGED',
    true,
  )
  const status = record(application.status, 'application.status')
  equal(
    record(status.sync, 'application.status.sync').status,
    'Synced',
    'application sync status',
    'ARGO_NOT_CONVERGED',
    true,
  )
  equal(
    record(status.health, 'application.status.health').status,
    'Healthy',
    'application health',
    'ARGO_NOT_CONVERGED',
    true,
  )
  const operationState = record(status.operationState, 'application.status.operationState')
  equal(operationState.phase, 'Succeeded', 'application operation phase', 'ARGO_NOT_CONVERGED', true)
}

const validateRestateArgoApplications = (value: unknown): void => {
  const list = record(value, 'restateApplications')
  const items = array(list.items, 'restateApplications.items')
  const expectedNames = ['restate', 'restate-operator', 'restate-operator-crds'] as const
  const byName = new Map(
    items.map((candidate) => {
      const application = record(candidate, 'restateApplications.items[]')
      const name = string(
        record(application.metadata, 'restateApplication.metadata').name,
        'restateApplication.metadata.name',
      )
      return [name, application] as const
    }),
  )
  for (const name of expectedNames) {
    const application = byName.get(name)
    if (application === undefined) {
      fail('ARGO_NOT_CONVERGED', `required Restate Argo application ${name} is missing`, true)
    }
    const status = record(application.status, `restateApplications.${name}.status`)
    equal(
      record(status.sync, `restateApplications.${name}.status.sync`).status,
      'Synced',
      `restateApplications.${name} sync status`,
      'ARGO_NOT_CONVERGED',
      true,
    )
    equal(
      record(status.health, `restateApplications.${name}.status.health`).status,
      'Healthy',
      `restateApplications.${name} health`,
      'ARGO_NOT_CONVERGED',
      true,
    )
  }
}

export const readArgoRevision = (value: unknown): string => {
  const revision = string(
    record(record(record(value, 'application').status, 'application.status').sync, 'application.status.sync').revision,
    'application.status.sync.revision',
  )
  if (!sourcePattern.test(revision)) return fail('ARGO_NOT_CONVERGED', 'Argo sync revision is not a full SHA', true)
  return revision
}

const validateDeployment = (value: unknown, expected: ExpectedBaynProduction): void => {
  const deployment = record(value, 'deployment')
  const metadata = record(deployment.metadata, 'deployment.metadata')
  equal(metadata.name, 'bayn', 'deployment.metadata.name', 'WORKLOAD_NOT_CONVERGED', true)
  const spec = record(deployment.spec, 'deployment.spec')
  equal(spec.replicas, 1, 'deployment.spec.replicas', 'WORKLOAD_NOT_CONVERGED', true)
  const container = firstContainer(deployment, 'bayn', 'deployment')
  equal(container.image, expected.imageReference, 'deployment live image', 'WORKLOAD_NOT_CONVERGED', true)
  const env = environment(container, 'deployment.container')
  equal(
    env.get('BAYN_CODE_REVISION'),
    expected.sourceRevision,
    'deployment live source',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
  equal(env.get('BAYN_IMAGE_DIGEST'), expected.imageDigest, 'deployment live digest', 'WORKLOAD_NOT_CONVERGED', true)
  equal(
    env.get('BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH'),
    expected.executionControllerPlanHash,
    'deployment live controller plan',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
  equal(
    env.get('BAYN_AUTHORITY_GENERATION_HASH'),
    expected.authorityGenerationHash,
    'deployment live authority generation',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
  equal(
    env.get('BAYN_BROKER_ACCESS'),
    'read-only',
    'deployment live broker access',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  equal(
    env.get('BAYN_CAPITAL_AUTHORITY'),
    'none',
    'deployment live capital authority',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  const status = record(deployment.status, 'deployment.status')
  equal(
    status.observedGeneration,
    integer(metadata.generation, 'deployment.metadata.generation'),
    'deployment observed generation',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
  for (const name of ['replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas'] as const) {
    equal(status[name], 1, `deployment.status.${name}`, 'WORKLOAD_NOT_CONVERGED', true)
  }
  equal(
    optionalCount(status.unavailableReplicas, 'deployment.status.unavailableReplicas'),
    0,
    'deployment unavailable replicas',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
}

const validateExecutionController = (value: unknown, expected: ExpectedBaynProduction): void => {
  const controller = record(value, 'executionController')
  const metadata = record(controller.metadata, 'executionController.metadata')
  equal(metadata.name, 'bayn-execution-controller', 'executionController.metadata.name', 'WORKLOAD_NOT_CONVERGED', true)
  const spec = record(controller.spec, 'executionController.spec')
  equal(spec.replicas, 1, 'executionController.spec.replicas', 'WORKLOAD_NOT_CONVERGED', true)
  const container = firstContainer(controller, 'execution-controller', 'executionController')
  equal(container.image, expected.imageReference, 'executionController live image', 'WORKLOAD_NOT_CONVERGED', true)
  const env = environment(container, 'executionController.container')
  equal(
    env.get('BAYN_CODE_REVISION'),
    expected.sourceRevision,
    'executionController live source',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
  equal(
    env.get('BAYN_IMAGE_DIGEST'),
    expected.imageDigest,
    'executionController live digest',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
  equal(
    env.get('BAYN_AUTHORITY_GENERATION_HASH'),
    expected.authorityGenerationHash,
    'executionController live authority generation',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
  equal(
    env.get('BAYN_BROKER_ACCESS'),
    'read-only',
    'executionController broker access',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  equal(
    env.get('BAYN_CAPITAL_AUTHORITY'),
    'none',
    'executionController capital authority',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  if (controller.status === undefined || controller.status === null) {
    fail('WORKLOAD_NOT_CONVERGED', 'executionController.status is not projected yet', true)
  }
  const status = record(controller.status, 'executionController.status')
  equal(
    status.observedGeneration,
    integer(metadata.generation, 'executionController.metadata.generation'),
    'executionController observed generation',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
  equal(status.desiredReplicas, 1, 'executionController desired replicas', 'WORKLOAD_NOT_CONVERGED', true)
  equal(status.readyReplicas, 1, 'executionController ready replicas', 'WORKLOAD_NOT_CONVERGED', true)
  equal(
    optionalCount(status.unavailableReplicas, 'executionController.status.unavailableReplicas'),
    0,
    'executionController unavailable replicas',
    'WORKLOAD_NOT_CONVERGED',
    true,
  )
  const ready = array(status.conditions, 'executionController.status.conditions').some((candidate) => {
    const condition = record(candidate, 'executionController.status.conditions[]')
    return condition.type === 'Ready' && condition.status === 'True'
  })
  if (!ready) fail('WORKLOAD_NOT_CONVERGED', 'RestateDeployment Ready condition is not true', true)
  string(status.deploymentId, 'executionController.status.deploymentId')
}

const sensitiveKeyPattern = /(?:accountId|apiKey|credential|keyId|password|secret|token)$/i

const rejectSensitiveFields = (value: unknown, path = 'status'): void => {
  if (Array.isArray(value)) {
    value.forEach((candidate, index) => rejectSensitiveFields(candidate, `${path}[${index}]`))
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) {
      fail('PRODUCTION_CONTRACT_VIOLATION', `${path}.${key} exposes a sensitive field`, false)
    }
    rejectSensitiveFields(child, `${path}.${key}`)
  }
}

const validateReadiness = (value: unknown, nowMs: number, maximumAgeMs: number): void => {
  const readiness = record(value, 'readiness')
  equal(readiness.ready, true, 'readiness.ready', 'RUNTIME_NOT_READY', true)
  equal(readiness.status, 'READY', 'readiness.status', 'RUNTIME_NOT_READY', true)
  if (array(readiness.failedDependencies, 'readiness.failedDependencies').length !== 0) {
    fail('RUNTIME_NOT_READY', 'readiness reports failed dependencies', true)
  }
  if (integer(readiness.probeSequence, 'readiness.probeSequence') < 1) {
    fail('RUNTIME_NOT_READY', 'readiness probe sequence has not advanced', true)
  }
  freshInstant(readiness.checkedAt, 'readiness.checkedAt', nowMs, maximumAgeMs)
}

const validateStatus = (
  value: unknown,
  expected: ExpectedBaynProduction,
  nowMs: number,
  maximumAgeMs: number,
  reconciliationStaleThresholdMs: number,
): void => {
  rejectSensitiveFields(value)
  const status = record(value, 'status')
  equal(status.service, 'bayn', 'status.service', 'PRODUCTION_CONTRACT_VIOLATION', false)
  const operational = record(status.operational, 'status.operational')
  equal(operational.status, 'READY', 'status.operational.status', 'RUNTIME_NOT_READY', true)
  equal(operational.ready, true, 'status.operational.ready', 'RUNTIME_NOT_READY', true)
  freshInstant(operational.checkedAt, 'status.operational.checkedAt', nowMs, maximumAgeMs)

  const dependencies = record(status.dependencies, 'status.dependencies')
  const requiredDependencyNames = ['postgresql', 'signal', 'tigerBeetle', 'evidence', 'cycle', 'cycleRunner'] as const
  const dependencyNames = Object.keys(dependencies).sort()
  const expectedDependencyNames = [...requiredDependencyNames].sort()
  if (
    dependencyNames.length !== expectedDependencyNames.length ||
    dependencyNames.some((name, index) => name !== expectedDependencyNames[index])
  ) {
    fail(
      'PRODUCTION_CONTRACT_VIOLATION',
      `status.dependencies must contain exactly ${expectedDependencyNames.join(', ')}`,
      false,
    )
  }
  for (const name of requiredDependencyNames) {
    const candidate = dependencies[name]
    const dependency = record(candidate, `status.dependencies.${name}`)
    equal(dependency.status, 'AVAILABLE', `status.dependencies.${name}.status`, 'RUNTIME_NOT_READY', true)
    equal(dependency.error, null, `status.dependencies.${name}.error`, 'RUNTIME_NOT_READY', true)
    freshInstant(dependency.checkedAt, `status.dependencies.${name}.checkedAt`, nowMs, maximumAgeMs)
  }

  const loop = record(status.autonomousCycleLoop, 'status.autonomousCycleLoop')
  equal(loop.configured, true, 'status.autonomousCycleLoop.configured', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(loop.owner, 'Restate', 'status.autonomousCycleLoop.owner', 'PRODUCTION_CONTRACT_VIOLATION', false)
  const cadence = record(loop.cadence, 'status.autonomousCycleLoop.cadence')
  const cadenceCondition = string(cadence.condition, 'status.autonomousCycleLoop.cadence.condition')
  const cadenceReason = string(cadence.reason, 'status.autonomousCycleLoop.cadence.reason')
  if (
    cadenceCondition === 'STALLED' ||
    cadenceReason === 'LATEST_PASS_FAILED' ||
    cadenceReason === 'RUNNER_UNAVAILABLE'
  ) {
    fail('RUNTIME_NOT_READY', 'autonomous cycle cadence reports an unhealthy Restate runner', true)
  }
  if (loop.lastPass !== null && loop.lastPass !== undefined) {
    const lastPass = record(loop.lastPass, 'status.autonomousCycleLoop.lastPass')
    equal(lastPass.result, 'SUCCESS', 'status.autonomousCycleLoop.lastPass.result', 'RUNTIME_NOT_READY', true)
    freshInstant(lastPass.observedAt, 'status.autonomousCycleLoop.lastPass.observedAt', nowMs, maximumAgeMs)
  }

  const executionController = record(status.executionController, 'status.executionController')
  equal(
    executionController.configured,
    true,
    'status.executionController.configured',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  equal(executionController.readAvailable, true, 'status.executionController.readAvailable', 'RUNTIME_NOT_READY', true)
  equal(executionController.reasonCode, null, 'status.executionController.reasonCode', 'RUNTIME_NOT_READY', true)
  freshInstant(executionController.checkedAt, 'status.executionController.checkedAt', nowMs, maximumAgeMs)
  if (executionController.status === null || executionController.status === undefined) {
    fail('RUNTIME_NOT_READY', 'status.executionController.status is not projected yet', true)
  }
  const controllerStatus = record(executionController.status, 'status.executionController.status')
  equal(controllerStatus.active, true, 'status.executionController.status.active', 'RUNTIME_NOT_READY', true)
  equal(
    controllerStatus.planHash,
    expected.executionControllerPlanHash,
    'status.executionController.status.planHash',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  if (integer(controllerStatus.epoch, 'status.executionController.status.epoch') < 1) {
    fail('RUNTIME_NOT_READY', 'execution-controller epoch has not advanced', true)
  }
  if (integer(controllerStatus.lastSequence, 'status.executionController.status.lastSequence') < 0) {
    fail('RUNTIME_NOT_READY', 'execution-controller sequence is invalid', true)
  }
  const lastOutcome = string(controllerStatus.lastOutcome, 'status.executionController.status.lastOutcome')
  if (lastOutcome !== 'Blocked' && lastOutcome !== 'Completed') {
    fail('RUNTIME_NOT_READY', `execution-controller outcome ${lastOutcome} is not terminal`, true)
  }
  if (
    !hashPattern.test(string(controllerStatus.lastReceiptHash, 'status.executionController.status.lastReceiptHash'))
  ) {
    fail('PRODUCTION_CONTRACT_VIOLATION', 'execution-controller receipt hash is invalid', false)
  }
  freshInstant(controllerStatus.completedAt, 'status.executionController.status.completedAt', nowMs, maximumAgeMs)

  const broker = record(status.broker, 'status.broker')
  equal(broker.configured, true, 'status.broker.configured', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(broker.accountBound, true, 'status.broker.accountBound', 'RUNTIME_NOT_READY', true)
  equal(broker.readAvailable, true, 'status.broker.readAvailable', 'RUNTIME_NOT_READY', true)
  equal(broker.executionEligible, false, 'status.broker.executionEligible', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(
    broker.executionDisabledReason,
    'BROKER_ACCESS_READ_ONLY',
    'status.broker.executionDisabledReason',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  equal(broker.reasonCode, null, 'status.broker.reasonCode', 'RUNTIME_NOT_READY', true)
  equal(broker.error, null, 'status.broker.error', 'RUNTIME_NOT_READY', true)
  freshInstant(broker.checkedAt, 'status.broker.checkedAt', nowMs, maximumAgeMs)

  const authority = record(status.authority, 'status.authority')
  equal(
    authority.brokerEnvironment,
    'sandbox',
    'status.authority.brokerEnvironment',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  equal(authority.brokerAccess, 'read-only', 'status.authority.brokerAccess', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(authority.capitalAuthority, 'none', 'status.authority.capitalAuthority', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(authority.brokerOrders, false, 'status.authority.brokerOrders', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(authority.capitalPromotion, false, 'status.authority.capitalPromotion', 'PRODUCTION_CONTRACT_VIOLATION', false)
  const durable = record(authority.durable, 'status.authority.durable')
  equal(durable.available, true, 'status.authority.durable.available', 'RUNTIME_NOT_READY', true)
  equal(durable.configured, true, 'status.authority.durable.configured', 'RUNTIME_NOT_READY', true)
  equal(durable.maximum, 'observe', 'status.authority.durable.maximum', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(durable.effective, 'observe', 'status.authority.durable.effective', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(durable.kill, 'clear', 'status.authority.durable.kill', 'PRODUCTION_CONTRACT_VIOLATION', false)

  const activation = record(status.capitalActivation, 'status.capitalActivation')
  equal(activation._tag, 'NotConfigured', 'status.capitalActivation._tag', 'PRODUCTION_CONTRACT_VIOLATION', false)

  const cycle = record(status.cycle, 'status.cycle')
  equal(cycle.observationAvailable, true, 'status.cycle.observationAvailable', 'RUNTIME_NOT_READY', true)
  const condition = string(cycle.condition, 'status.cycle.condition')
  if (condition === 'UNKNOWN' || condition === 'FAILED' || condition === 'STALLED') {
    fail('RUNTIME_NOT_READY', `cycle condition ${condition} is not operational`, true)
  }
  equal(cycle.error, null, 'status.cycle.error', 'RUNTIME_NOT_READY', true)
  freshInstant(cycle.checkedAt, 'status.cycle.checkedAt', nowMs, maximumAgeMs)
  equal(cycle.unfinishedCycleCount, 0, 'status.cycle.unfinishedCycleCount', 'RUNTIME_NOT_READY', true)
  const mutations = record(cycle.mutations, 'status.cycle.mutations')
  const mutationEventCount = integer(mutations.eventCount, 'status.cycle.mutations.eventCount')
  if (mutationEventCount < 0) {
    fail('PRODUCTION_CONTRACT_VIOLATION', 'status.cycle.mutations.eventCount cannot be negative', false)
  }
  equal(
    mutations.approvedIntentCount,
    0,
    'status.cycle.mutations.approvedIntentCount',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  equal(
    mutations.acknowledgedIntentCount,
    0,
    'status.cycle.mutations.acknowledgedIntentCount',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  equal(mutations.unresolvedCount, 0, 'status.cycle.mutations.unresolvedCount', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(
    mutations.oldestUnresolvedAt,
    null,
    'status.cycle.mutations.oldestUnresolvedAt',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  for (const [name, active] of Object.entries(record(cycle.alerts, 'status.cycle.alerts'))) {
    equal(active, false, `status.cycle.alerts.${name}`, 'PRODUCTION_CONTRACT_VIOLATION', false)
  }
  if (cycle.reconciliation === null || cycle.reconciliation === undefined) {
    fail('RUNTIME_NOT_READY', 'status.cycle.reconciliation is not available yet', true)
  }
  const reconciliation = record(cycle.reconciliation, 'status.cycle.reconciliation')
  equal(reconciliation.status, 'EXACT', 'status.cycle.reconciliation.status', 'RUNTIME_NOT_READY', true)
  equal(
    reconciliation.discrepancyCount,
    0,
    'status.cycle.reconciliation.discrepancyCount',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  equal(
    reconciliation.coversLatestMutation,
    true,
    'status.cycle.reconciliation.coversLatestMutation',
    'RUNTIME_NOT_READY',
    true,
  )
  equal(
    cycle.reconciliationCoversLatestMutation,
    true,
    'status.cycle.reconciliationCoversLatestMutation',
    'RUNTIME_NOT_READY',
    true,
  )
  const reconciliationAgeMs = integer(cycle.reconciliationAgeMs, 'status.cycle.reconciliationAgeMs')
  if (reconciliationAgeMs < 0 || reconciliationAgeMs >= reconciliationStaleThresholdMs) {
    fail('RUNTIME_NOT_READY', 'status.cycle.reconciliationAgeMs crossed the configured stale threshold', true)
  }
  freshInstant(reconciliation.reconciledAt, 'status.cycle.reconciliation.reconciledAt', nowMs, maximumAgeMs)

  const build = record(status.build, 'status.build')
  equal(
    build.sourceRevision,
    expected.sourceRevision,
    'status.build.sourceRevision',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  const image = record(build.image, 'status.build.image')
  equal(
    image.repository,
    expected.imageRepository,
    'status.build.image.repository',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  equal(image.digest, expected.imageDigest, 'status.build.image.digest', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(build.verification, 'embedded', 'status.build.verification', 'PRODUCTION_CONTRACT_VIOLATION', false)
  equal(status.error, null, 'status.error', 'RUNTIME_NOT_READY', true)
}

const metricValue = (metrics: string, metric: string, labels = ''): number => {
  const escaped = `${metric}${labels}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...metrics.matchAll(new RegExp(`^${escaped} ([0-9]+(?:\\.[0-9]+)?)$`, 'gm'))]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    return fail('RUNTIME_NOT_READY', `metric ${metric}${labels} is missing or ambiguous`, true)
  }
  return Number(matches[0][1])
}

const validateMetrics = (metrics: string): number => {
  const required: readonly [string, string, number][] = [
    ['bayn_runtime_ready', '', 1],
    ['bayn_autonomous_cycle_owner', '{owner="restate"}', 1],
    ['bayn_autonomous_cycle_loop_health_available', '', 1],
    ['bayn_execution_controller_configured', '', 1],
    ['bayn_execution_controller_read_available', '', 1],
    ['bayn_intents', '{state="approved"}', 0],
    ['bayn_intents', '{state="acknowledged"}', 0],
    ['bayn_unresolved_mutations', '', 0],
    ['bayn_reconciliation_available', '', 1],
    ['bayn_reconciliation_exact', '', 1],
    ['bayn_reconciliation_covers_latest_mutation', '', 1],
    ['bayn_broker_access', '{access="read-only"}', 1],
    ['bayn_broker_access', '{access="mutation"}', 0],
    ['bayn_authority_coherent', '', 1],
    ['bayn_authority_kill_active', '', 0],
    ['bayn_broker_orders_enabled', '', 0],
    ['bayn_capital_promotion_enabled', '', 0],
    ['bayn_capital_authority', '{authority="none"}', 1],
  ]
  for (const [metric, labels, expected] of required) {
    equal(
      metricValue(metrics, metric, labels),
      expected,
      `metrics.${metric}${labels}`,
      'PRODUCTION_CONTRACT_VIOLATION',
      false,
    )
  }
  const lifetimeMutationCount = metricValue(metrics, 'bayn_mutation_events_total')
  if (!Number.isFinite(lifetimeMutationCount) || lifetimeMutationCount < 0) {
    fail('PRODUCTION_CONTRACT_VIOLATION', 'lifetime mutation counter is invalid', false)
  }
  const reconciliationStaleThresholdSeconds = metricValue(metrics, 'bayn_reconciliation_stale_threshold_seconds')
  if (!Number.isFinite(reconciliationStaleThresholdSeconds) || reconciliationStaleThresholdSeconds <= 0) {
    fail('PRODUCTION_CONTRACT_VIOLATION', 'reconciliation stale threshold metric is invalid', false)
  }
  return reconciliationStaleThresholdSeconds * 1_000
}

export const validateBaynPostDeploySnapshot = (
  snapshot: BaynPostDeploySnapshot,
  expected: ExpectedBaynProduction,
  nowMs = Date.now(),
  maximumEvidenceAgeMs = defaultEvidenceAgeMs,
): void => {
  const reconciliationStaleThresholdMs = validateMetrics(snapshot.metrics)
  validateArgo(snapshot.application)
  validateRestateArgoApplications(snapshot.restateApplications)
  validateDeployment(snapshot.deployment, expected)
  validateExecutionController(snapshot.executionController, expected)
  validateReadiness(snapshot.readiness, nowMs, maximumEvidenceAgeMs)
  validateStatus(snapshot.status, expected, nowMs, maximumEvidenceAgeMs, reconciliationStaleThresholdMs)
}

type CommandResult = { readonly stdout: string; readonly stderr: string; readonly exitCode: number }

export type RunCommand = (command: readonly string[]) => Promise<CommandResult>
export type ReadHttp = (url: string) => Promise<string>

const baynServiceOrigin = 'http://bayn.bayn.svc.cluster.local:80'
const baynHttpReadTimeoutMs = 5_000

export const runCommand: RunCommand = async (command) => {
  try {
    const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exitCode }
  } catch {
    return fail('READ_UNAVAILABLE', `failed to execute ${command[0] ?? 'command'}`, true)
  }
}

export const readHttp: ReadHttp = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(baynHttpReadTimeoutMs) })
    const body = await response.text()
    if (!response.ok) return fail('READ_UNAVAILABLE', `Bayn HTTP read returned ${response.status}`, true)
    return body
  } catch (error) {
    if (error instanceof BaynPostDeployFailure) throw error
    return fail('READ_UNAVAILABLE', 'Bayn HTTP read failed', true)
  }
}

const requireCommand = (result: CommandResult, label: string, retryable: boolean): string => {
  if (result.exitCode !== 0) return fail('READ_UNAVAILABLE', `${label} read failed`, retryable)
  return result.stdout
}

const jsonOutput = (result: CommandResult, label: string): unknown => {
  const output = requireCommand(result, label, true)
  try {
    return JSON.parse(output) as unknown
  } catch {
    return fail('READ_UNAVAILABLE', `${label} returned invalid JSON`, true)
  }
}

export const fetchBaynPostDeploySnapshot = async (
  run: RunCommand,
  readBaynHttp: ReadHttp = readHttp,
): Promise<BaynPostDeploySnapshot> => {
  const [application, restateApplications, deployment, executionController, readiness, status, metrics] =
    await Promise.all([
      run(['kubectl', 'get', 'application', 'bayn', '-n', 'argocd', '-o', 'json']),
      run([
        'kubectl',
        'get',
        'application',
        'restate',
        'restate-operator',
        'restate-operator-crds',
        '-n',
        'argocd',
        '-o',
        'json',
      ]),
      run(['kubectl', 'get', 'deployment', 'bayn', '-n', 'bayn', '-o', 'json']),
      run(['kubectl', 'get', 'restatedeployment', 'bayn-execution-controller', '-n', 'bayn', '-o', 'json']),
      readBaynHttp(`${baynServiceOrigin}/readyz`),
      readBaynHttp(`${baynServiceOrigin}/v1/status`),
      readBaynHttp(`${baynServiceOrigin}/metrics`),
    ])
  return {
    application: jsonOutput(application, 'Argo application'),
    restateApplications: jsonOutput(restateApplications, 'Restate Argo applications'),
    deployment: jsonOutput(deployment, 'Bayn deployment'),
    executionController: jsonOutput(executionController, 'Bayn RestateDeployment'),
    readiness: (() => {
      try {
        return JSON.parse(readiness) as unknown
      } catch {
        return fail('READ_UNAVAILABLE', 'Bayn readiness returned invalid JSON', true)
      }
    })(),
    status: (() => {
      try {
        return JSON.parse(status) as unknown
      } catch {
        return fail('READ_UNAVAILABLE', 'Bayn status returned invalid JSON', true)
      }
    })(),
    metrics,
  }
}

const gitCheck = async (
  run: RunCommand,
  args: readonly string[],
  code: BaynPostDeployFailureCode,
  message: string,
  retryable: boolean,
): Promise<void> => {
  const result = await run(['git', ...args])
  if (result.exitCode === 0) return
  if (result.exitCode === 1) return fail(code, message, retryable)
  return fail('READ_UNAVAILABLE', 'Git revision verification failed', true)
}

export const verifyBaynRevisionLineage = async (
  run: RunCommand,
  expectedRevision: string,
  reconciledRevision: string,
): Promise<void> => {
  if (!sourcePattern.test(expectedRevision) || !sourcePattern.test(reconciledRevision)) {
    return fail('INVALID_MANIFEST', 'revision lineage requires full commit SHAs', false)
  }
  const fetch = await run(['git', 'fetch', '--no-tags', '--quiet', 'origin', 'main'])
  if (fetch.exitCode !== 0) return fail('READ_UNAVAILABLE', 'origin/main could not be refreshed', true)
  await gitCheck(
    run,
    ['merge-base', '--is-ancestor', expectedRevision, reconciledRevision],
    'REVISION_NOT_CONVERGED',
    'Argo has not reconciled the triggering main revision',
    true,
  )
  await gitCheck(
    run,
    ['merge-base', '--is-ancestor', reconciledRevision, 'origin/main'],
    'PRODUCTION_CONTRACT_VIOLATION',
    'Argo revision is not on current main',
    false,
  )
  const manifestDiff = await run([
    'git',
    'diff',
    '--quiet',
    `${expectedRevision}..${reconciledRevision}`,
    '--',
    'argocd/applications/bayn',
  ])
  if (manifestDiff.exitCode === 1) {
    return fail(
      'REVISION_NOT_CONVERGED',
      'a later main revision superseded the triggering Bayn production manifests',
      false,
    )
  }
  if (manifestDiff.exitCode !== 0) return fail('READ_UNAVAILABLE', 'Bayn manifest lineage diff failed', true)
}

export const verifyReadOnlyBaynIdentity = async (run: RunCommand): Promise<void> => {
  const deniedChecks: readonly (readonly string[])[] = [
    ['get', 'secrets', '-n', 'bayn'],
    ['list', 'secrets', '-n', 'bayn'],
    ['get', 'pods', '-n', 'bayn'],
    ['list', 'pods', '-n', 'bayn'],
    ['create', 'deployments.apps', '-n', 'bayn'],
    ['update', 'deployments.apps', '-n', 'bayn'],
    ['patch', 'deployments.apps', '-n', 'bayn'],
    ['delete', 'deployments.apps', '-n', 'bayn'],
    ['deletecollection', 'deployments.apps', '-n', 'bayn'],
    ['update', 'deployments.apps/scale', '-n', 'bayn'],
    ['create', 'restatedeployments.restate.dev', '-n', 'bayn'],
    ['update', 'restatedeployments.restate.dev', '-n', 'bayn'],
    ['patch', 'restatedeployments.restate.dev', '-n', 'bayn'],
    ['delete', 'restatedeployments.restate.dev', '-n', 'bayn'],
    ['deletecollection', 'restatedeployments.restate.dev', '-n', 'bayn'],
    ['get', 'services/proxy', '-n', 'bayn'],
    ['create', 'services/proxy', '-n', 'bayn'],
    ['update', 'services/proxy', '-n', 'bayn'],
    ['patch', 'services/proxy', '-n', 'bayn'],
    ['delete', 'services/proxy', '-n', 'bayn'],
    ['create', 'pods/eviction', '-n', 'bayn'],
    ['patch', 'applications.argoproj.io', '-n', 'argocd'],
    ['update', 'applications.argoproj.io', '-n', 'argocd'],
  ]
  for (const check of deniedChecks) {
    const result = await run(['kubectl', 'auth', 'can-i', ...check])
    if (result.exitCode !== 0 && result.stdout.trim() !== 'no') {
      return fail('READ_UNAVAILABLE', `authorization probe failed for ${check.join(' ')}`, true)
    }
    if (result.stdout.trim() !== 'no') {
      return fail('PRODUCTION_CONTRACT_VIOLATION', `verifier identity can ${check.join(' ')}`, false)
    }
  }
}

export const retryBaynPostDeployVerification = async (
  operation: () => Promise<void>,
  options: {
    readonly deadlineMs: number
    readonly intervalMs: number
    readonly now?: () => number
    readonly sleep?: (milliseconds: number) => Promise<void>
  },
): Promise<void> => {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds))
  const deadline = now() + options.deadlineMs
  let last: BaynPostDeployFailure | undefined
  while (now() <= deadline) {
    try {
      await operation()
      return
    } catch (error) {
      const failure =
        error instanceof BaynPostDeployFailure
          ? error
          : new BaynPostDeployFailure('PRODUCTION_CONTRACT_VIOLATION', 'unexpected verifier failure', false)
      if (!failure.retryable) throw failure
      last = failure
    }
    if (now() + options.intervalMs > deadline) break
    await sleep(options.intervalMs)
  }
  return fail('VERIFICATION_TIMEOUT', `deadline expired; last blocker was ${last?.code ?? 'unknown'}`, false)
}

type CliOptions = {
  readonly expectedRevision: string
  readonly root: string
  readonly deadlineSeconds: number
  readonly intervalSeconds: number
  readonly maximumEvidenceAgeSeconds: number
}

const positiveNumber = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fail('INVALID_MANIFEST', `${name} must be positive`, false)
  return parsed
}

const parseCli = (args: readonly string[]): CliOptions => {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name === undefined || !name.startsWith('--') || value === undefined || value.startsWith('--')) {
      return fail('INVALID_MANIFEST', `invalid CLI argument ${name ?? ''}`, false)
    }
    values.set(name, value)
  }
  const expectedRevision = values.get('--expected-revision') ?? ''
  if (!sourcePattern.test(expectedRevision)) {
    return fail('INVALID_MANIFEST', '--expected-revision must be a full commit SHA', false)
  }
  return {
    expectedRevision,
    root: values.get('--root') ?? process.cwd(),
    deadlineSeconds: positiveNumber(values.get('--deadline-seconds') ?? '900', '--deadline-seconds'),
    intervalSeconds: positiveNumber(values.get('--interval-seconds') ?? '10', '--interval-seconds'),
    maximumEvidenceAgeSeconds: positiveNumber(
      values.get('--maximum-evidence-age-seconds') ?? '180',
      '--maximum-evidence-age-seconds',
    ),
  }
}

const main = async (): Promise<void> => {
  const options = parseCli(process.argv.slice(2))
  const [kustomization, deployment, executionController] = await Promise.all([
    readFile(join(options.root, 'argocd/applications/bayn/kustomization.yaml'), 'utf8'),
    readFile(join(options.root, 'argocd/applications/bayn/deployment.yaml'), 'utf8'),
    readFile(join(options.root, 'argocd/applications/bayn/execution-controller.yaml'), 'utf8'),
  ])
  const expected = parseExpectedBaynProduction(kustomization, deployment, executionController)
  await retryBaynPostDeployVerification(
    async () => {
      await verifyReadOnlyBaynIdentity(runCommand)
      const snapshot = await fetchBaynPostDeploySnapshot(runCommand)
      const reconciledRevision = readArgoRevision(snapshot.application)
      await verifyBaynRevisionLineage(runCommand, options.expectedRevision, reconciledRevision)
      validateBaynPostDeploySnapshot(snapshot, expected, Date.now(), options.maximumEvidenceAgeSeconds * 1_000)
    },
    { deadlineMs: options.deadlineSeconds * 1_000, intervalMs: options.intervalSeconds * 1_000 },
  )
  console.log(
    `Bayn production contract verified for GitOps ${options.expectedRevision}, source ${expected.sourceRevision}, digest ${expected.imageDigest}`,
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Bayn post-deploy verification failed')
    process.exitCode = 1
  })
}
