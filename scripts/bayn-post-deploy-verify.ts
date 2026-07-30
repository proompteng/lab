#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const SOURCE_PATTERN = /^[0-9a-f]{40}$/
const TAG_PATTERN = /^sha-([0-9a-f]{40})$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const IMAGE_REPOSITORY = 'registry.ide-newton.ts.net/lab/bayn'
const REQUIRED_DEPENDENCIES = ['postgresql', 'signal', 'tigerBeetle', 'evidence', 'cycle', 'cycleRunner'] as const
const REQUIRED_ALERTS = [
  'cycleStalled',
  'cycleFailed',
  'unknownMutationStale',
  'reconciliationBlocked',
  'killActive',
  'authorityIncoherent',
] as const
const SENSITIVE_KEY_PATTERN = /(?:account.?id|broker.?identity|authorization|credential|key.?id|password|secret|token)/i

type JsonRecord = Record<string, unknown>

export type ExpectedPromotion = {
  readonly sourceRevision: string
  readonly tag: string
  readonly digest: string
  readonly repository: string
  readonly imageReference: string
}

export type VerificationSnapshot = {
  readonly application: unknown
  readonly deployment: unknown
  readonly pods: unknown
  readonly readiness: unknown
  readonly status: unknown
  readonly metrics: unknown
}

export type VerificationFailureCode =
  | 'ARGO_NOT_CONVERGED'
  | 'DEPLOYMENT_NOT_CONVERGED'
  | 'ENDPOINT_UNAVAILABLE'
  | 'INVALID_MANIFEST'
  | 'POD_NOT_CONVERGED'
  | 'PRODUCTION_CONTRACT_VIOLATION'
  | 'RBAC_DENIED'
  | 'VERIFICATION_INTERRUPTED'
  | 'VERIFICATION_TIMEOUT'

export class VerificationFailure extends Error {
  constructor(
    readonly code: VerificationFailureCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${code}: ${message}`)
    this.name = 'VerificationFailure'
  }
}

const record = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VerificationFailure('PRODUCTION_CONTRACT_VIOLATION', `${path} must be an object`, false)
  }
  return value as JsonRecord
}

const array = (value: unknown, path: string): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new VerificationFailure('PRODUCTION_CONTRACT_VIOLATION', `${path} must be an array`, false)
  }
  return value
}

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VerificationFailure('PRODUCTION_CONTRACT_VIOLATION', `${path} must be a non-empty string`, false)
  }
  return value
}

const integer = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new VerificationFailure('PRODUCTION_CONTRACT_VIOLATION', `${path} must be an integer`, false)
  }
  return value
}

const optionalInteger = (value: unknown, path: string): number => (value === undefined ? 0 : integer(value, path))

const fail = (code: VerificationFailureCode, message: string, retryable: boolean): never => {
  throw new VerificationFailure(code, message, retryable)
}

const requireEqual = (
  actual: unknown,
  expected: string | number | boolean | null,
  path: string,
  code: VerificationFailureCode,
  retryable: boolean,
): void => {
  if (actual !== expected) fail(code, `${path} did not match the required value`, retryable)
}

const parseYaml = (source: string, path: string): JsonRecord => {
  try {
    return record(Bun.YAML.parse(source), path)
  } catch (error) {
    if (error instanceof VerificationFailure) throw error
    return fail('INVALID_MANIFEST', `${path} is not valid YAML`, false)
  }
}

const envValues = (container: JsonRecord, path: string): ReadonlyMap<string, string> => {
  const entries = array(container.env, `${path}.env`)
  const values = new Map<string, string>()
  for (const [index, entry] of entries.entries()) {
    const item = record(entry, `${path}.env[${index}]`)
    const name = string(item.name, `${path}.env[${index}].name`)
    if (typeof item.value === 'string') values.set(name, item.value)
  }
  return values
}

const namedContainer = (containers: unknown, name: string, path: string): JsonRecord => {
  const matches = array(containers, path).filter((candidate) => {
    const item = record(candidate, path)
    return item.name === name
  })
  if (matches.length !== 1)
    fail('PRODUCTION_CONTRACT_VIOLATION', `${path} must contain exactly one ${name} container`, false)
  return record(matches[0], `${path}.${name}`)
}

export const parseExpectedPromotion = (kustomizationSource: string, deploymentSource: string): ExpectedPromotion => {
  const kustomization = parseYaml(kustomizationSource, 'kustomization')
  const images = array(kustomization.images, 'kustomization.images')
  if (images.length !== 1) fail('INVALID_MANIFEST', 'kustomization.images must contain exactly one image', false)
  const image = record(images[0], 'kustomization.images[0]')
  const repository = string(image.newName, 'kustomization.images[0].newName')
  const tag = string(image.newTag, 'kustomization.images[0].newTag')
  const digest = string(image.digest, 'kustomization.images[0].digest')
  requireEqual(image.name, IMAGE_REPOSITORY, 'kustomization.images[0].name', 'INVALID_MANIFEST', false)
  requireEqual(repository, IMAGE_REPOSITORY, 'kustomization.images[0].newName', 'INVALID_MANIFEST', false)
  const tagMatch = TAG_PATTERN.exec(tag)
  if (tagMatch === null)
    return fail('INVALID_MANIFEST', 'image tag must contain the full immutable source revision', false)
  const sourceFromTag = tagMatch?.[1]
  if (sourceFromTag === undefined) return fail('INVALID_MANIFEST', 'image tag is missing the source revision', false)
  if (!DIGEST_PATTERN.test(digest)) fail('INVALID_MANIFEST', 'image digest must be a full sha256 digest', false)

  const deployment = parseYaml(deploymentSource, 'deployment')
  const spec = record(deployment.spec, 'deployment.spec')
  const template = record(spec.template, 'deployment.spec.template')
  const podSpec = record(template.spec, 'deployment.spec.template.spec')
  const container = namedContainer(podSpec.containers, 'bayn', 'deployment.spec.template.spec.containers')
  requireEqual(container.image, repository, 'deployment container image base', 'INVALID_MANIFEST', false)
  const env = envValues(container, 'deployment.spec.template.spec.containers.bayn')
  const sourceRevision = env.get('BAYN_CODE_REVISION')
  if (sourceRevision === undefined || !SOURCE_PATTERN.test(sourceRevision)) {
    return fail('INVALID_MANIFEST', 'BAYN_CODE_REVISION must be a full source revision', false)
  }
  requireEqual(sourceRevision, sourceFromTag, 'BAYN_CODE_REVISION', 'INVALID_MANIFEST', false)
  requireEqual(env.get('BAYN_IMAGE_REPOSITORY'), repository, 'BAYN_IMAGE_REPOSITORY', 'INVALID_MANIFEST', false)
  requireEqual(env.get('BAYN_IMAGE_DIGEST'), digest, 'BAYN_IMAGE_DIGEST', 'INVALID_MANIFEST', false)
  requireEqual(env.get('BAYN_BROKER_ENVIRONMENT'), 'sandbox', 'BAYN_BROKER_ENVIRONMENT', 'INVALID_MANIFEST', false)
  requireEqual(env.get('BAYN_MAXIMUM_AUTHORITY'), 'OBSERVE', 'BAYN_MAXIMUM_AUTHORITY', 'INVALID_MANIFEST', false)

  return {
    sourceRevision,
    tag,
    digest,
    repository,
    imageReference: `${repository}:${tag}@${digest}`,
  }
}

const validateArgo = (
  applicationValue: unknown,
  reconciledRevision: string,
  promotionRevision: string,
  expected: ExpectedPromotion,
): void => {
  const application = record(applicationValue, 'application')
  requireEqual(
    record(application.metadata, 'application.metadata').name,
    'bayn',
    'application.metadata.name',
    'ARGO_NOT_CONVERGED',
    true,
  )
  const spec = record(application.spec, 'application.spec')
  const source = record(spec.source, 'application.spec.source')
  requireEqual(source.path, 'argocd/applications/bayn', 'application.spec.source.path', 'ARGO_NOT_CONVERGED', true)
  requireEqual(
    source.repoURL,
    'https://github.com/proompteng/lab.git',
    'application.spec.source.repoURL',
    'ARGO_NOT_CONVERGED',
    true,
  )
  requireEqual(source.targetRevision, 'main', 'application.spec.source.targetRevision', 'ARGO_NOT_CONVERGED', true)
  requireEqual(
    record(spec.destination, 'application.spec.destination').namespace,
    'bayn',
    'application.spec.destination.namespace',
    'ARGO_NOT_CONVERGED',
    true,
  )
  const status = record(application.status, 'application.status')
  const sync = record(status.sync, 'application.status.sync')
  requireEqual(sync.status, 'Synced', 'application.status.sync.status', 'ARGO_NOT_CONVERGED', true)
  requireEqual(sync.revision, reconciledRevision, 'application.status.sync.revision', 'ARGO_NOT_CONVERGED', true)
  requireEqual(
    record(status.health, 'application.status.health').status,
    'Healthy',
    'application.status.health.status',
    'ARGO_NOT_CONVERGED',
    true,
  )
  const operation = record(status.operationState, 'application.status.operationState')
  requireEqual(operation.phase, 'Succeeded', 'application.status.operationState.phase', 'ARGO_NOT_CONVERGED', true)
  const syncResult = record(operation.syncResult, 'application.status.operationState.syncResult')
  const operationRevision = string(syncResult.revision, 'application.status.operationState.syncResult.revision')
  if (operationRevision !== promotionRevision && operationRevision !== reconciledRevision) {
    fail('ARGO_NOT_CONVERGED', 'Argo operation does not prove the promotion or reconciled revision', true)
  }
  const operationDeployment = array(
    syncResult.resources,
    'application.status.operationState.syncResult.resources',
  ).find((candidate) => {
    const resource = record(candidate, 'application.status.operationState.syncResult.resources[]')
    return (
      resource.group === 'apps' &&
      resource.kind === 'Deployment' &&
      resource.name === 'bayn' &&
      resource.namespace === 'bayn'
    )
  })
  if (operationDeployment !== undefined) {
    const operationDeploymentRecord = record(
      operationDeployment,
      'application.status.operationState.syncResult.resources.bayn',
    )
    requireEqual(
      operationDeploymentRecord.status,
      'Synced',
      'application.status.operationState.syncResult.resources.bayn.status',
      'ARGO_NOT_CONVERGED',
      true,
    )
  }
  if (reconciledRevision !== promotionRevision) {
    const promotionHistory = array(status.history, 'application.status.history').find((candidate) => {
      const history = record(candidate, 'application.status.history[]')
      return history.revision === promotionRevision
    })
    if (promotionHistory === undefined) {
      fail('ARGO_NOT_CONVERGED', 'Argo history does not prove the promotion revision reconciled', true)
    }
    const history = record(promotionHistory, 'application.status.history.promotion')
    string(history.deployedAt, 'application.status.history.promotion.deployedAt')
    const historySource = record(history.source, 'application.status.history.promotion.source')
    requireEqual(
      historySource.path,
      'argocd/applications/bayn',
      'application.status.history.promotion.source.path',
      'ARGO_NOT_CONVERGED',
      true,
    )
    requireEqual(
      historySource.repoURL,
      'https://github.com/proompteng/lab.git',
      'application.status.history.promotion.source.repoURL',
      'ARGO_NOT_CONVERGED',
      true,
    )
  }
  const images = array(record(status.summary, 'application.status.summary').images, 'application.status.summary.images')
  if (!images.includes(expected.imageReference)) {
    fail('ARGO_NOT_CONVERGED', 'Argo summary does not contain the exact promoted image', true)
  }
  const deploymentResource = array(status.resources, 'application.status.resources').find((candidate) => {
    const resource = record(candidate, 'application.status.resources[]')
    return (
      resource.group === 'apps' &&
      resource.kind === 'Deployment' &&
      resource.name === 'bayn' &&
      resource.namespace === 'bayn'
    )
  })
  if (deploymentResource === undefined) {
    fail('ARGO_NOT_CONVERGED', 'Argo does not report the Bayn Deployment resource', true)
  }
  requireEqual(
    record(deploymentResource, 'application.status.resources.bayn').status,
    'Synced',
    'application.status.resources.bayn.status',
    'ARGO_NOT_CONVERGED',
    true,
  )
}

const validateDeployment = (deploymentValue: unknown, expected: ExpectedPromotion): void => {
  const deployment = record(deploymentValue, 'deployment')
  const metadata = record(deployment.metadata, 'deployment.metadata')
  requireEqual(metadata.name, 'bayn', 'deployment.metadata.name', 'DEPLOYMENT_NOT_CONVERGED', true)
  const spec = record(deployment.spec, 'deployment.spec')
  requireEqual(spec.replicas, 1, 'deployment.spec.replicas', 'DEPLOYMENT_NOT_CONVERGED', true)
  const template = record(spec.template, 'deployment.spec.template')
  const podSpec = record(template.spec, 'deployment.spec.template.spec')
  const container = namedContainer(podSpec.containers, 'bayn', 'deployment.spec.template.spec.containers')
  requireEqual(container.image, expected.imageReference, 'deployment container image', 'DEPLOYMENT_NOT_CONVERGED', true)
  const env = envValues(container, 'deployment.spec.template.spec.containers.bayn')
  requireEqual(
    env.get('BAYN_CODE_REVISION'),
    expected.sourceRevision,
    'deployment source revision',
    'DEPLOYMENT_NOT_CONVERGED',
    true,
  )
  requireEqual(
    env.get('BAYN_IMAGE_DIGEST'),
    expected.digest,
    'deployment image digest',
    'DEPLOYMENT_NOT_CONVERGED',
    true,
  )
  const status = record(deployment.status, 'deployment.status')
  requireEqual(
    status.observedGeneration,
    integer(metadata.generation, 'deployment.metadata.generation'),
    'deployment observedGeneration',
    'DEPLOYMENT_NOT_CONVERGED',
    true,
  )
  for (const key of ['replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas'] as const) {
    requireEqual(status[key], 1, `deployment.status.${key}`, 'DEPLOYMENT_NOT_CONVERGED', true)
  }
  requireEqual(
    optionalInteger(status.unavailableReplicas, 'deployment.status.unavailableReplicas'),
    0,
    'deployment unavailable replicas',
    'DEPLOYMENT_NOT_CONVERGED',
    true,
  )
  requireEqual(
    optionalInteger(status.terminatingReplicas, 'deployment.status.terminatingReplicas'),
    0,
    'deployment terminating replicas',
    'DEPLOYMENT_NOT_CONVERGED',
    true,
  )
}

const validatePod = (podsValue: unknown, expected: ExpectedPromotion): void => {
  const pods = record(podsValue, 'pods')
  const items = array(pods.items, 'pods.items')
  if (items.length !== 1) fail('POD_NOT_CONVERGED', 'exactly one Bayn pod must exist', true)
  const pod = record(items[0], 'pods.items[0]')
  const metadata = record(pod.metadata, 'pod.metadata')
  if (metadata.deletionTimestamp !== undefined) fail('POD_NOT_CONVERGED', 'Bayn pod is terminating', true)
  const spec = record(pod.spec, 'pod.spec')
  const container = namedContainer(spec.containers, 'bayn', 'pod.spec.containers')
  requireEqual(container.image, expected.imageReference, 'pod container image', 'POD_NOT_CONVERGED', true)
  const env = envValues(container, 'pod.spec.containers.bayn')
  requireEqual(env.get('BAYN_CODE_REVISION'), expected.sourceRevision, 'pod source revision', 'POD_NOT_CONVERGED', true)
  requireEqual(env.get('BAYN_IMAGE_DIGEST'), expected.digest, 'pod image digest', 'POD_NOT_CONVERGED', true)
  const status = record(pod.status, 'pod.status')
  requireEqual(status.phase, 'Running', 'pod.status.phase', 'POD_NOT_CONVERGED', true)
  const ready = array(status.conditions, 'pod.status.conditions').some((condition) => {
    const item = record(condition, 'pod.status.conditions[]')
    return item.type === 'Ready' && item.status === 'True'
  })
  if (!ready) fail('POD_NOT_CONVERGED', 'Bayn pod is not Ready', true)
  const containerStatus = namedContainer(status.containerStatuses, 'bayn', 'pod.status.containerStatuses')
  requireEqual(containerStatus.ready, true, 'pod container ready', 'POD_NOT_CONVERGED', true)
  requireEqual(containerStatus.started, true, 'pod container started', 'POD_NOT_CONVERGED', true)
  requireEqual(containerStatus.restartCount, 0, 'pod container restartCount', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(
    containerStatus.imageID,
    `${expected.repository}@${expected.digest}`,
    'pod container imageID',
    'POD_NOT_CONVERGED',
    true,
  )
  const state = record(containerStatus.state, 'pod container state')
  if (state.running === undefined || state.waiting !== undefined || state.terminated !== undefined) {
    fail('PRODUCTION_CONTRACT_VIOLATION', 'Bayn container is not in an uninterrupted running state', false)
  }
  const lastState = record(containerStatus.lastState ?? {}, 'pod container lastState')
  if (Object.keys(lastState).length !== 0) {
    fail('PRODUCTION_CONTRACT_VIOLATION', 'Bayn container has prior termination evidence', false)
  }
}

const validateReadiness = (readinessValue: unknown): void => {
  const readiness = record(readinessValue, 'readiness')
  requireEqual(readiness.ready, true, 'readiness.ready', 'ENDPOINT_UNAVAILABLE', true)
  requireEqual(readiness.status, 'READY', 'readiness.status', 'ENDPOINT_UNAVAILABLE', true)
  if (array(readiness.failedDependencies, 'readiness.failedDependencies').length !== 0) {
    fail('ENDPOINT_UNAVAILABLE', 'readiness reports failed dependencies', true)
  }
  if (integer(readiness.probeSequence, 'readiness.probeSequence') < 1) {
    fail('ENDPOINT_UNAVAILABLE', 'readiness probe sequence has not advanced', true)
  }
  string(readiness.checkedAt, 'readiness.checkedAt')
}

const reconciliationStaleThresholdMs = (metricsValue: unknown): number => {
  if (typeof metricsValue !== 'string') {
    return fail('ENDPOINT_UNAVAILABLE', 'Bayn metrics response must be text', true)
  }
  const samples = metricsValue
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line.startsWith('bayn_reconciliation_stale_threshold_seconds '))
  if (samples.length !== 1) {
    return fail('ENDPOINT_UNAVAILABLE', 'Bayn reconciliation stale threshold metric must have exactly one sample', true)
  }
  const sample = samples[0]
  if (sample === undefined) {
    return fail('ENDPOINT_UNAVAILABLE', 'Bayn reconciliation stale threshold metric is missing', true)
  }
  const match = /^bayn_reconciliation_stale_threshold_seconds ([0-9]+(?:\.[0-9]+)?)$/.exec(sample)
  if (match === null) {
    return fail('ENDPOINT_UNAVAILABLE', 'Bayn reconciliation stale threshold metric is invalid', true)
  }
  const thresholdValue = match[1]
  if (thresholdValue === undefined) {
    return fail('ENDPOINT_UNAVAILABLE', 'Bayn reconciliation stale threshold metric has no value', true)
  }
  const thresholdSeconds = Number(thresholdValue)
  const thresholdMs = thresholdSeconds * 1_000
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    fail('ENDPOINT_UNAVAILABLE', 'Bayn reconciliation stale threshold metric must be positive', true)
  }
  return thresholdMs
}

const assertNoSensitiveFields = (value: unknown, path = 'status'): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`))
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      fail('PRODUCTION_CONTRACT_VIOLATION', `${path} contains forbidden sensitive identity field`, false)
    }
    assertNoSensitiveFields(child, `${path}.${key}`)
  }
}

const validateAuthority = (authorityValue: unknown): void => {
  const authority = record(authorityValue, 'status.authority')
  requireEqual(
    authority.brokerEnvironment,
    'sandbox',
    'authority.brokerEnvironment',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  requireEqual(authority.brokerAccess, 'read-only', 'authority.brokerAccess', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(authority.capitalAuthority, 'none', 'authority.capitalAuthority', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(authority.brokerOrders, false, 'authority.brokerOrders', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(authority.capitalPromotion, false, 'authority.capitalPromotion', 'PRODUCTION_CONTRACT_VIOLATION', false)
  const durable = record(authority.durable, 'status.authority.durable')
  requireEqual(durable.available, true, 'authority.durable.available', 'PRODUCTION_CONTRACT_VIOLATION', false)
  if (durable.configured === false) {
    for (const field of ['maximum', 'effective', 'kill', 'reason', 'updatedAt'] as const) {
      requireEqual(durable[field], null, `authority.durable.${field}`, 'PRODUCTION_CONTRACT_VIOLATION', false)
    }
    return
  }
  requireEqual(durable.configured, true, 'authority.durable.configured', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(durable.maximum, 'observe', 'authority.durable.maximum', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(durable.effective, 'observe', 'authority.durable.effective', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(durable.kill, 'clear', 'authority.durable.kill', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(durable.reason, null, 'authority.durable.reason', 'PRODUCTION_CONTRACT_VIOLATION', false)
  string(durable.updatedAt, 'authority.durable.updatedAt')
}

const validateStatus = (
  statusValue: unknown,
  expected: ExpectedPromotion,
  reconciliationStaleThresholdMs: number,
): void => {
  assertNoSensitiveFields(statusValue)
  const status = record(statusValue, 'status')
  requireEqual(status.service, 'bayn', 'status.service', 'PRODUCTION_CONTRACT_VIOLATION', false)
  const operational = record(status.operational, 'status.operational')
  requireEqual(operational.status, 'READY', 'status.operational.status', 'ENDPOINT_UNAVAILABLE', true)
  requireEqual(operational.ready, true, 'status.operational.ready', 'ENDPOINT_UNAVAILABLE', true)
  if (integer(operational.probeSequence, 'status.operational.probeSequence') < 1) {
    fail('ENDPOINT_UNAVAILABLE', 'status operational probe sequence has not advanced', true)
  }
  string(operational.checkedAt, 'status.operational.checkedAt')
  const dependencies = record(status.dependencies, 'status.dependencies')
  for (const name of REQUIRED_DEPENDENCIES) {
    const dependency = record(dependencies[name], `status.dependencies.${name}`)
    requireEqual(dependency.status, 'AVAILABLE', `status.dependencies.${name}.status`, 'ENDPOINT_UNAVAILABLE', true)
    requireEqual(dependency.error, null, `status.dependencies.${name}.error`, 'ENDPOINT_UNAVAILABLE', true)
    string(dependency.checkedAt, `status.dependencies.${name}.checkedAt`)
  }
  for (const [name, value] of Object.entries(dependencies)) {
    const dependency = record(value, `status.dependencies.${name}`)
    requireEqual(dependency.status, 'AVAILABLE', `status.dependencies.${name}.status`, 'ENDPOINT_UNAVAILABLE', true)
    requireEqual(dependency.error, null, `status.dependencies.${name}.error`, 'ENDPOINT_UNAVAILABLE', true)
  }
  const loop = record(status.autonomousCycleLoop, 'status.autonomousCycleLoop')
  requireEqual(loop.configured, true, 'status.autonomousCycleLoop.configured', 'PRODUCTION_CONTRACT_VIOLATION', false)
  string(loop.startedAt, 'status.autonomousCycleLoop.startedAt')
  if (loop.lastPass === null || loop.lastPass === undefined) {
    fail('ENDPOINT_UNAVAILABLE', 'status.autonomousCycleLoop.lastPass is not available yet', true)
  }
  const lastPass = record(loop.lastPass, 'status.autonomousCycleLoop.lastPass')
  requireEqual(lastPass.result, 'SUCCESS', 'status.autonomousCycleLoop.lastPass.result', 'ENDPOINT_UNAVAILABLE', true)
  string(lastPass.observedAt, 'status.autonomousCycleLoop.lastPass.observedAt')
  string(lastPass.outcome, 'status.autonomousCycleLoop.lastPass.outcome')
  validateAuthority(status.authority)

  const broker = record(status.broker, 'status.broker')
  requireEqual(broker.configured, true, 'status.broker.configured', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(broker.accountBound, true, 'status.broker.accountBound', 'ENDPOINT_UNAVAILABLE', true)
  requireEqual(broker.readAvailable, true, 'status.broker.readAvailable', 'ENDPOINT_UNAVAILABLE', true)
  string(broker.checkedAt, 'status.broker.checkedAt')
  requireEqual(
    broker.executionEligible,
    false,
    'status.broker.executionEligible',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  requireEqual(
    broker.executionDisabledReason,
    'BROKER_ACCESS_READ_ONLY',
    'status.broker.executionDisabledReason',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  requireEqual(broker.reasonCode, null, 'status.broker.reasonCode', 'ENDPOINT_UNAVAILABLE', true)
  requireEqual(broker.error, null, 'status.broker.error', 'ENDPOINT_UNAVAILABLE', true)

  const cycle = record(status.cycle, 'status.cycle')
  requireEqual(cycle.observationAvailable, true, 'status.cycle.observationAvailable', 'ENDPOINT_UNAVAILABLE', true)
  const condition = string(cycle.condition, 'status.cycle.condition')
  if (['UNKNOWN', 'FAILED', 'STALLED'].includes(condition)) {
    fail('ENDPOINT_UNAVAILABLE', 'status.cycle.condition is not operational', true)
  }
  string(cycle.reason, 'status.cycle.reason')
  string(cycle.checkedAt, 'status.cycle.checkedAt')
  requireEqual(cycle.zeroMutation, true, 'status.cycle.zeroMutation', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(cycle.error, null, 'status.cycle.error', 'ENDPOINT_UNAVAILABLE', true)
  const mutations = record(cycle.mutations, 'status.cycle.mutations')
  requireEqual(mutations.eventCount, 0, 'status.cycle.mutations.eventCount', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(
    mutations.unresolvedCount,
    0,
    'status.cycle.mutations.unresolvedCount',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  requireEqual(
    mutations.oldestUnresolvedAt,
    null,
    'status.cycle.mutations.oldestUnresolvedAt',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  requireEqual(
    mutations.latestOccurredAt,
    null,
    'status.cycle.mutations.latestOccurredAt',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  const alerts = record(cycle.alerts, 'status.cycle.alerts')
  for (const name of REQUIRED_ALERTS) {
    requireEqual(alerts[name], false, `status.cycle.alerts.${name}`, 'PRODUCTION_CONTRACT_VIOLATION', false)
  }
  for (const [name, value] of Object.entries(alerts)) {
    requireEqual(value, false, `status.cycle.alerts.${name}`, 'PRODUCTION_CONTRACT_VIOLATION', false)
  }
  if (cycle.reconciliation === null || cycle.reconciliation === undefined) {
    fail('ENDPOINT_UNAVAILABLE', 'status.cycle.reconciliation is not available yet', true)
  }
  const reconciliation = record(cycle.reconciliation, 'status.cycle.reconciliation')
  requireEqual(reconciliation.status, 'EXACT', 'status.cycle.reconciliation.status', 'ENDPOINT_UNAVAILABLE', true)
  requireEqual(
    reconciliation.discrepancyCount,
    0,
    'status.cycle.reconciliation.discrepancyCount',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  requireEqual(
    reconciliation.coversLatestMutation,
    true,
    'status.cycle.reconciliation.coversLatestMutation',
    'ENDPOINT_UNAVAILABLE',
    true,
  )
  requireEqual(
    cycle.reconciliationCoversLatestMutation,
    true,
    'status.cycle.reconciliationCoversLatestMutation',
    'ENDPOINT_UNAVAILABLE',
    true,
  )
  string(reconciliation.reconciledAt, 'status.cycle.reconciliation.reconciledAt')
  const reconciliationAgeMs = integer(cycle.reconciliationAgeMs, 'status.cycle.reconciliationAgeMs')
  if (reconciliationAgeMs < 0) {
    fail('ENDPOINT_UNAVAILABLE', 'status.cycle.reconciliationAgeMs cannot be negative', true)
  }
  if (reconciliationAgeMs >= reconciliationStaleThresholdMs) {
    fail('ENDPOINT_UNAVAILABLE', 'status.cycle.reconciliation is stale', true)
  }

  const build = record(status.build, 'status.build')
  requireEqual(
    build.sourceRevision,
    expected.sourceRevision,
    'status.build.sourceRevision',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  const image = record(build.image, 'status.build.image')
  requireEqual(
    image.repository,
    expected.repository,
    'status.build.image.repository',
    'PRODUCTION_CONTRACT_VIOLATION',
    false,
  )
  requireEqual(image.digest, expected.digest, 'status.build.image.digest', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(build.verification, 'embedded', 'status.build.verification', 'PRODUCTION_CONTRACT_VIOLATION', false)
  requireEqual(status.error, null, 'status.error', 'ENDPOINT_UNAVAILABLE', true)
}

export const validateSnapshot = (
  snapshot: VerificationSnapshot,
  reconciledRevision: string,
  expected: ExpectedPromotion,
  promotionRevision = reconciledRevision,
): void => {
  if (!SOURCE_PATTERN.test(reconciledRevision) || !SOURCE_PATTERN.test(promotionRevision)) {
    fail('INVALID_MANIFEST', 'Argo revisions must be full commit SHAs', false)
  }
  validateArgo(snapshot.application, reconciledRevision, promotionRevision, expected)
  validateDeployment(snapshot.deployment, expected)
  validatePod(snapshot.pods, expected)
  validateReadiness(snapshot.readiness)
  validateStatus(snapshot.status, expected, reconciliationStaleThresholdMs(snapshot.metrics))
}

export const redactSensitive = (message: string): string =>
  message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:account.?id|broker.?identity|authorization|credential|key.?id|password|secret|token)\s*[:=]\s*)[^\s,;}]+/gi,
      '$1[REDACTED]',
    )

type CommandResult = { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
export type RunCommand = (command: readonly string[], signal: AbortSignal) => Promise<CommandResult>

const failureFromAbortSignal = (signal: AbortSignal): VerificationFailure =>
  signal.reason instanceof VerificationFailure
    ? signal.reason
    : new VerificationFailure('VERIFICATION_INTERRUPTED', 'verification was interrupted', false)

export const runCommand: RunCommand = async (command, signal) => {
  if (signal.aborted) throw failureFromAbortSignal(signal)
  const process = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe', signal })
  const terminate = () => {
    try {
      process.kill()
    } catch {
      // The process may already have exited. The abort reason still controls the verifier result.
    }
  }
  try {
    signal.addEventListener('abort', terminate, { once: true })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (signal.aborted) throw failureFromAbortSignal(signal)
    return { stdout, stderr, exitCode }
  } catch {
    if (signal.aborted) throw failureFromAbortSignal(signal)
    return fail('ENDPOINT_UNAVAILABLE', 'read command could not be executed', true)
  } finally {
    signal.removeEventListener('abort', terminate)
  }
}

const parseJsonOutput = (result: CommandResult, label: string, retryable: boolean): unknown => {
  if (result.exitCode !== 0) {
    const stderr = redactSensitive(result.stderr)
    if (/forbidden|unauthorized|cannot get resource/i.test(stderr)) {
      fail('RBAC_DENIED', `${label} read was denied`, false)
    }
    fail('ENDPOINT_UNAVAILABLE', `${label} read failed`, retryable)
  }
  try {
    return JSON.parse(result.stdout) as unknown
  } catch {
    fail('ENDPOINT_UNAVAILABLE', `${label} returned invalid JSON`, retryable)
  }
}

const parseTextOutput = (result: CommandResult, label: string, retryable: boolean): string => {
  if (result.exitCode !== 0) {
    const stderr = redactSensitive(result.stderr)
    if (/forbidden|unauthorized|cannot get resource/i.test(stderr)) {
      fail('RBAC_DENIED', `${label} read was denied`, false)
    }
    fail('ENDPOINT_UNAVAILABLE', `${label} read failed`, retryable)
  }
  if (result.stdout.length === 0) fail('ENDPOINT_UNAVAILABLE', `${label} returned an empty response`, retryable)
  return result.stdout
}

const checkReadPermission = async (
  run: RunCommand,
  signal: AbortSignal,
  verb: string,
  resource: string,
  namespace: string,
) => {
  const result = await run(['kubectl', 'auth', 'can-i', verb, resource, '-n', namespace], signal)
  const decision = result.stdout.trim()
  if (result.exitCode !== 0 || result.stderr.trim().length !== 0 || (decision !== 'yes' && decision !== 'no')) {
    fail('RBAC_DENIED', `${verb} ${resource} in ${namespace} permission probe was indeterminate`, false)
  }
  if (decision !== 'yes') {
    fail('RBAC_DENIED', `missing ${verb} permission for ${resource} in ${namespace}`, false)
  }
}

const requireConclusiveDenial = (result: CommandResult, permission: string, grantedMessage: string): void => {
  const decision = result.stdout.trim()
  if (result.exitCode !== 0 || result.stderr.trim().length !== 0 || (decision !== 'yes' && decision !== 'no')) {
    fail('RBAC_DENIED', `${permission} permission probe was indeterminate`, false)
  }
  if (decision === 'yes') fail('RBAC_DENIED', grantedMessage, false)
}

const checkWriteDenied = async (run: RunCommand, signal: AbortSignal, resource: string, namespace: string) => {
  for (const verb of ['create', 'update', 'patch', 'delete', 'deletecollection']) {
    const result = await run(['kubectl', 'auth', 'can-i', verb, resource, '-n', namespace], signal)
    requireConclusiveDenial(
      result,
      `${verb} ${resource} in ${namespace}`,
      `workflow identity unexpectedly has ${verb} permission for ${resource} in ${namespace}`,
    )
  }
}

export const validateReadOnlyPermissions = async (run: RunCommand, signal: AbortSignal): Promise<void> => {
  await checkReadPermission(run, signal, 'get', 'applications.argoproj.io', 'argocd')
  await checkReadPermission(run, signal, 'get', 'deployments.apps', 'bayn')
  await checkReadPermission(run, signal, 'list', 'pods', 'bayn')
  await checkReadPermission(run, signal, 'get', 'services/proxy', 'bayn')
  await checkWriteDenied(run, signal, 'applications.argoproj.io', 'argocd')
  await checkWriteDenied(run, signal, 'deployments.apps', 'bayn')
  await checkWriteDenied(run, signal, 'deployments.apps/scale', 'bayn')
  await checkWriteDenied(run, signal, 'pods', 'bayn')
  await checkWriteDenied(run, signal, 'pods/eviction', 'bayn')
  await checkWriteDenied(run, signal, 'pods/exec', 'bayn')
  await checkWriteDenied(run, signal, 'pods/portforward', 'bayn')
  await checkWriteDenied(run, signal, 'secrets', 'bayn')
  for (const verb of ['get', 'list', 'watch']) {
    const secretRead = await run(['kubectl', 'auth', 'can-i', verb, 'secrets', '-n', 'bayn'], signal)
    requireConclusiveDenial(
      secretRead,
      `${verb} secrets in bayn`,
      `workflow identity unexpectedly has ${verb} secret permission in bayn`,
    )
  }
}

export const readArgoSyncRevision = (applicationValue: unknown): string => {
  const application = record(applicationValue, 'application')
  const status = record(application.status, 'application.status')
  const sync = record(status.sync, 'application.status.sync')
  const revision = string(sync.revision, 'application.status.sync.revision')
  if (!SOURCE_PATTERN.test(revision)) {
    fail('ARGO_NOT_CONVERGED', 'Argo sync revision is not a full commit SHA', true)
  }
  return revision
}

const runGitCheck = async (
  run: RunCommand,
  signal: AbortSignal,
  command: readonly string[],
  retryableFailure: string,
): Promise<void> => {
  const result = await run(command, signal)
  if (result.exitCode === 0) return
  if (result.exitCode === 1) fail('ARGO_NOT_CONVERGED', retryableFailure, true)
  fail('ENDPOINT_UNAVAILABLE', 'Git revision verification failed', true)
}

export const verifyArgoRevision = async (
  run: RunCommand,
  signal: AbortSignal,
  root: string,
  promotionRevision: string,
  reconciledRevision: string,
): Promise<void> => {
  if (!SOURCE_PATTERN.test(promotionRevision) || !SOURCE_PATTERN.test(reconciledRevision)) {
    fail('ARGO_NOT_CONVERGED', 'Argo revision verification requires full commit SHAs', true)
  }
  if (promotionRevision === reconciledRevision) return

  const fetch = await run(['git', '-C', root, 'fetch', '--no-tags', '--quiet', 'origin', 'main'], signal)
  if (fetch.exitCode !== 0) fail('ENDPOINT_UNAVAILABLE', 'Current main revision could not be refreshed', true)
  await runGitCheck(
    run,
    signal,
    ['git', '-C', root, 'merge-base', '--is-ancestor', reconciledRevision, 'origin/main'],
    'Argo revision is not on current main',
  )
  await runGitCheck(
    run,
    signal,
    ['git', '-C', root, 'merge-base', '--is-ancestor', promotionRevision, reconciledRevision],
    'Argo has not reconciled the promotion revision or a verified descendant',
  )
  const manifestDiff = await run(
    [
      'git',
      '-C',
      root,
      'diff',
      '--quiet',
      `${promotionRevision}..${reconciledRevision}`,
      '--',
      'argocd/applications/bayn/deployment.yaml',
      'argocd/applications/bayn/kustomization.yaml',
    ],
    signal,
  )
  if (manifestDiff.exitCode === 1) {
    fail('PRODUCTION_CONTRACT_VIOLATION', 'A later main revision superseded the promoted Bayn manifests', false)
  }
  if (manifestDiff.exitCode !== 0) fail('ENDPOINT_UNAVAILABLE', 'Bayn manifest lineage could not be verified', true)
}

const fetchSnapshot = async (run: RunCommand, signal: AbortSignal): Promise<VerificationSnapshot> => {
  const [application, deployment, pods, readiness, status, metrics] = await Promise.all([
    run(['kubectl', 'get', 'application', 'bayn', '-n', 'argocd', '-o', 'json'], signal),
    run(['kubectl', 'get', 'deployment', 'bayn', '-n', 'bayn', '-o', 'json'], signal),
    run(['kubectl', 'get', 'pods', '-n', 'bayn', '-l', 'app.kubernetes.io/name=bayn', '-o', 'json'], signal),
    run(['kubectl', 'get', '--raw', '/api/v1/namespaces/bayn/services/http:bayn:80/proxy/readyz'], signal),
    run(['kubectl', 'get', '--raw', '/api/v1/namespaces/bayn/services/http:bayn:80/proxy/v1/status'], signal),
    run(['kubectl', 'get', '--raw', '/api/v1/namespaces/bayn/services/http:bayn:80/proxy/metrics'], signal),
  ])
  return {
    application: parseJsonOutput(application, 'Argo application', true),
    deployment: parseJsonOutput(deployment, 'Bayn deployment', true),
    pods: parseJsonOutput(pods, 'Bayn pods', true),
    readiness: parseJsonOutput(readiness, 'Bayn readiness endpoint', true),
    status: parseJsonOutput(status, 'Bayn status endpoint', true),
    metrics: parseTextOutput(metrics, 'Bayn metrics endpoint', true),
  }
}

export type RetryOptions = {
  readonly deadlineMs: number
  readonly deadlineAt?: number
  readonly intervalMs: number
  readonly now?: () => number
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>
    const abort = () => {
      clearTimeout(timeout)
      reject(new VerificationFailure('VERIFICATION_INTERRUPTED', 'verification was interrupted', false))
    }
    const complete = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    timeout = setTimeout(complete, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })

export const runWithinDeadline = async <Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  parentSignal: AbortSignal,
  deadlineAt: number,
  now: () => number = Date.now,
): Promise<Value> => {
  if (parentSignal.aborted) throw failureFromAbortSignal(parentSignal)
  const remainingMs = deadlineAt - now()
  if (remainingMs <= 0) {
    fail('VERIFICATION_TIMEOUT', 'configured verification deadline expired before the next operation', false)
  }

  const controller = new AbortController()
  const interrupted = () => controller.abort(failureFromAbortSignal(parentSignal))
  parentSignal.addEventListener('abort', interrupted, { once: true })
  const timeoutFailure = new VerificationFailure(
    'VERIFICATION_TIMEOUT',
    'configured verification deadline expired during an operation',
    false,
  )
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutFailure)
      reject(timeoutFailure)
    }, remainingMs)
  })

  try {
    const value = await Promise.race([operation(controller.signal), timeoutPromise])
    if (parentSignal.aborted) throw failureFromAbortSignal(parentSignal)
    if (controller.signal.aborted) throw failureFromAbortSignal(controller.signal)
    if (now() > deadlineAt) {
      controller.abort(timeoutFailure)
      throw timeoutFailure
    }
    return value
  } catch (error) {
    if (parentSignal.aborted) throw failureFromAbortSignal(parentSignal)
    if (controller.signal.aborted) throw failureFromAbortSignal(controller.signal)
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    parentSignal.removeEventListener('abort', interrupted)
  }
}

export const retryVerification = async (
  operation: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  options: RetryOptions,
): Promise<void> => {
  const now = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  const deadline = options.deadlineAt ?? now() + options.deadlineMs
  let lastFailure: VerificationFailure | undefined
  while (now() <= deadline) {
    if (signal.aborted) fail('VERIFICATION_INTERRUPTED', 'verification was interrupted', false)
    try {
      await runWithinDeadline(operation, signal, deadline, now)
      return
    } catch (error) {
      const failure =
        error instanceof VerificationFailure
          ? error
          : new VerificationFailure('ENDPOINT_UNAVAILABLE', 'unexpected verifier failure', false)
      if (!failure.retryable) throw failure
      lastFailure = failure
    }
    if (now() + options.intervalMs > deadline) break
    await wait(options.intervalMs, signal)
  }
  throw new VerificationFailure(
    'VERIFICATION_TIMEOUT',
    `deadline expired; last blocker was ${lastFailure?.code ?? 'unknown'}`,
    false,
  )
}

type CliOptions = {
  readonly expectedRevision: string
  readonly deadlineSeconds: number
  readonly intervalSeconds: number
  readonly root: string
}

const parsePositive = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) fail('INVALID_MANIFEST', `${name} must be positive`, false)
  return parsed
}

const parseCli = (args: readonly string[]): CliOptions => {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (!argument?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail('INVALID_MANIFEST', `invalid argument ${argument ?? ''}`, false)
    }
    values.set(argument, value)
    index += 1
  }
  const expectedRevision = values.get('--expected-revision') ?? ''
  if (!SOURCE_PATTERN.test(expectedRevision)) {
    fail('INVALID_MANIFEST', '--expected-revision must be a full commit SHA', false)
  }
  return {
    expectedRevision,
    deadlineSeconds: parsePositive(values.get('--deadline-seconds') ?? '900', '--deadline-seconds'),
    intervalSeconds: parsePositive(values.get('--interval-seconds') ?? '10', '--interval-seconds'),
    root: values.get('--root') ?? process.cwd(),
  }
}

const main = async (): Promise<void> => {
  const options = parseCli(process.argv.slice(2))
  const controller = new AbortController()
  const deadlineAt = Date.now() + options.deadlineSeconds * 1_000
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const kustomizationPath = join(options.root, 'argocd/applications/bayn/kustomization.yaml')
    const deploymentPath = join(options.root, 'argocd/applications/bayn/deployment.yaml')
    const [kustomizationSource, deploymentSource] = await runWithinDeadline(
      (signal) =>
        Promise.all([
          readFile(kustomizationPath, { encoding: 'utf8', signal }),
          readFile(deploymentPath, { encoding: 'utf8', signal }),
        ]),
      controller.signal,
      deadlineAt,
    )
    const expected = parseExpectedPromotion(kustomizationSource, deploymentSource)
    await runWithinDeadline((signal) => validateReadOnlyPermissions(runCommand, signal), controller.signal, deadlineAt)
    await retryVerification(
      async (signal) => {
        const snapshot = await fetchSnapshot(runCommand, signal)
        const reconciledRevision = readArgoSyncRevision(snapshot.application)
        await verifyArgoRevision(runCommand, signal, options.root, options.expectedRevision, reconciledRevision)
        validateSnapshot(snapshot, reconciledRevision, expected, options.expectedRevision)
      },
      controller.signal,
      {
        deadlineMs: options.deadlineSeconds * 1_000,
        deadlineAt,
        intervalMs: options.intervalSeconds * 1_000,
      },
    )
    console.log(
      `Bayn post-deploy verification passed for Argo revision ${options.expectedRevision}, source ${expected.sourceRevision}, digest ${expected.digest}`,
    )
  } catch (error) {
    const message = redactSensitive(error instanceof Error ? error.message : 'unknown verifier failure')
    console.error(message)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}

if (import.meta.main) await main()
