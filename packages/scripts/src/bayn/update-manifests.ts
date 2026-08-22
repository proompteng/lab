#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

import { validateNativeBaynDeployment } from './native-runtime-manifest'

const digestPattern = /^sha256:[0-9a-f]{64}$/
const hashPattern = /^[0-9a-f]{64}$/
const sourceShaPattern = /^[0-9a-f]{40}$/
const tagPattern = /^[A-Za-z0-9._-]{1,128}$/
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/
const decimalPattern = /^[0-9]+$/
const transportAddressesPattern = /^[A-Za-z0-9.[\]:_-]+(?:[ \t]*,[ \t]*[A-Za-z0-9.[\]:_-]+)*$/
const maximumTigerBeetleClusterId = (1n << 128n) - 1n
const maximumTigerBeetleLedger = 2 ** 32 - 1

/**
 * Restate's durable plan identifies the controller protocol, not a worker build.
 * Keep this in lockstep with services/bayn/src/composition/native-execution-runtime.ts.
 */
export const baynExecutionControllerPlanHash = createHash('sha256')
  .update('bayn.execution-controller-plan.v2')
  .digest('hex')

export interface BaynCandidateRuntime {
  readonly BAYN_SIGNAL_SNAPSHOT_ID: string
  readonly BAYN_SIGNAL_PUBLICATION_ASOF: string
  readonly BAYN_SIGNAL_CALENDAR_VERSION: string
  readonly BAYN_SIGNAL_DATA_START: string
  readonly BAYN_SIGNAL_DATA_END: string
  readonly BAYN_SIGNAL_LOOKBACK_START: string
  readonly BAYN_SIGNAL_EVALUATION_START: string
  readonly BAYN_SIGNAL_EVALUATION_END: string
  readonly BAYN_TIGERBEETLE_CLUSTER_ID: string
  readonly BAYN_TIGERBEETLE_ADDRESSES: string
  readonly BAYN_TIGERBEETLE_LEDGER: string
}

export interface UpdateBaynManifestOptions {
  readonly sourceSha: string
  readonly tag: string
  readonly digest: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly rolloutTimestamp: string
  readonly candidateRuntime?: BaynCandidateRuntime
  readonly acceptedQualificationRunId?: string
  /** Authored source whose ancestry was proved by the release workflow. Strategy identity is checked separately. */
  readonly researchLineageSourceSha?: string
  readonly deployedDeploymentPath?: string
  readonly kustomizationPath?: string
  readonly deploymentPath?: string
  readonly applicationSetPath?: string
  readonly executionControllerPath?: string
  readonly executionActivationPath?: string
}

interface ResearchCapitalBuildLineage {
  readonly schemaVersion: 'bayn.research-capital-build-lineage.v1'
  readonly requestHash: string
  readonly authoredActivation: ResearchCapitalBuildBinding
  readonly activation: ResearchCapitalBuildBinding
}

interface ResearchCapitalBuildBinding {
  readonly sourceRevision: string
  readonly imageRepository: string
  readonly imageDigest: string
}

export interface BaynManifestUpdate {
  readonly promotionAction: 'promote' | 'hold'
  readonly promotionReason:
    | 'eligible'
    | 'strategy-identity-change-requires-fresh-snapshot'
    | 'research-capital-activation-refresh-required'
  readonly qualificationMode: 'preserve' | 'replace' | 'install' | 'research'
  readonly hadQualificationPin: boolean
  readonly qualificationBindingsMatch: boolean
  readonly snapshotChanged: boolean
  readonly deployedQualificationRunId: string | null
  readonly candidateQualificationRunId: string | null
  readonly deployedSnapshotId: string
  readonly candidateSnapshotId: string
  readonly deployedSourceSha: string
  readonly deployedBehaviorHash: string
  readonly deployedParameterHash: string
  readonly candidateBehaviorHash: string
  readonly candidateParameterHash: string
}

const replaceExactlyOnce = (source: string, pattern: RegExp, replacement: string, name: string): string => {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))]
  if (matches.length !== 1) throw new Error(`expected exactly one ${name}`)
  return source.replace(pattern, replacement)
}

const replaceExactly = (
  source: string,
  pattern: RegExp,
  replacement: string,
  expectedMatches: number,
  name: string,
): string => {
  const globalPattern = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)
  const matches = [...source.matchAll(globalPattern)]
  if (matches.length !== expectedMatches) throw new Error(`expected exactly ${expectedMatches} ${name} values`)
  return source.replace(globalPattern, replacement)
}

const environmentValue = (deployment: string, name: string): string => {
  const pattern = new RegExp(`            - name: ${name}\\n              value: ([^\\n]+)\\n`, 'g')
  const matches = [...deployment.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`expected exactly one ${name} value`)
  const value = matches[0]?.[1]?.trim()
  if (value === undefined) throw new Error(`missing ${name} value`)
  return value.startsWith('"') ? String(JSON.parse(value)) : value
}

const qualificationPin = /            - name: BAYN_QUALIFICATION_RUN_ID\n              value: [^\n]+\n/
const capitalActivationRequest = /            - name: BAYN_CAPITAL_ACTIVATION_REQUEST\n/
const researchCapitalBuildContinuation = 'ResearchCapitalBuildContinuation'
const researchCapitalBuildLineageSchemaVersion = 'bayn.research-capital-build-lineage.v1' as const
const qualificationIdentityNames = [
  'BAYN_SIGNAL_SNAPSHOT_ID',
  'BAYN_SIGNAL_PUBLICATION_ASOF',
  'BAYN_SIGNAL_CALENDAR_VERSION',
  'BAYN_SIGNAL_DATA_START',
  'BAYN_SIGNAL_DATA_END',
  'BAYN_SIGNAL_LOOKBACK_START',
  'BAYN_SIGNAL_EVALUATION_START',
  'BAYN_SIGNAL_EVALUATION_END',
  'BAYN_TIGERBEETLE_CLUSTER_ID',
  'BAYN_TIGERBEETLE_LEDGER',
] as const
const candidateRuntimeNames = [...qualificationIdentityNames, 'BAYN_TIGERBEETLE_ADDRESSES'] as const
const researchRequestIdentityNames = [
  'BAYN_STRATEGY_BEHAVIOR_HASH',
  'BAYN_STRATEGY_PARAMETER_HASH',
  'BAYN_STRATEGY_NAME',
  'BAYN_STRATEGY_PROTOCOL_HASH',
  'BAYN_EXECUTION_RISK_POLICY_HASH',
] as const

const runtimeFromDeployment = (deployment: string): BaynCandidateRuntime => ({
  BAYN_SIGNAL_SNAPSHOT_ID: environmentValue(deployment, 'BAYN_SIGNAL_SNAPSHOT_ID'),
  BAYN_SIGNAL_PUBLICATION_ASOF: environmentValue(deployment, 'BAYN_SIGNAL_PUBLICATION_ASOF'),
  BAYN_SIGNAL_CALENDAR_VERSION: environmentValue(deployment, 'BAYN_SIGNAL_CALENDAR_VERSION'),
  BAYN_SIGNAL_DATA_START: environmentValue(deployment, 'BAYN_SIGNAL_DATA_START'),
  BAYN_SIGNAL_DATA_END: environmentValue(deployment, 'BAYN_SIGNAL_DATA_END'),
  BAYN_SIGNAL_LOOKBACK_START: environmentValue(deployment, 'BAYN_SIGNAL_LOOKBACK_START'),
  BAYN_SIGNAL_EVALUATION_START: environmentValue(deployment, 'BAYN_SIGNAL_EVALUATION_START'),
  BAYN_SIGNAL_EVALUATION_END: environmentValue(deployment, 'BAYN_SIGNAL_EVALUATION_END'),
  BAYN_TIGERBEETLE_CLUSTER_ID: environmentValue(deployment, 'BAYN_TIGERBEETLE_CLUSTER_ID'),
  BAYN_TIGERBEETLE_ADDRESSES: environmentValue(deployment, 'BAYN_TIGERBEETLE_ADDRESSES'),
  BAYN_TIGERBEETLE_LEDGER: environmentValue(deployment, 'BAYN_TIGERBEETLE_LEDGER'),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  return actual.length === required.length && actual.every((key, index) => key === required[index])
}

const decodeResearchCapitalBuildBinding = (value: unknown): ResearchCapitalBuildBinding | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, ['imageDigest', 'imageRepository', 'sourceRevision'])) return undefined
  return typeof value.sourceRevision === 'string' &&
    sourceShaPattern.test(value.sourceRevision) &&
    typeof value.imageRepository === 'string' &&
    value.imageRepository.length > 0 &&
    !/\s/.test(value.imageRepository) &&
    typeof value.imageDigest === 'string' &&
    digestPattern.test(value.imageDigest)
    ? {
        sourceRevision: value.sourceRevision,
        imageRepository: value.imageRepository,
        imageDigest: value.imageDigest,
      }
    : undefined
}

const researchCapitalBuildLineageFromManifest = (manifest: string, role: string): ResearchCapitalBuildLineage => {
  let value: unknown
  try {
    value = JSON.parse(environmentValue(manifest, 'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE')) as unknown
  } catch {
    throw new Error(`${role} BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE is not valid JSON`)
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['activation', 'authoredActivation', 'requestHash', 'schemaVersion']) ||
    value.schemaVersion !== researchCapitalBuildLineageSchemaVersion ||
    typeof value.requestHash !== 'string' ||
    !hashPattern.test(value.requestHash)
  ) {
    throw new Error(`${role} BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE is not canonical`)
  }
  const authoredActivation = decodeResearchCapitalBuildBinding(value.authoredActivation)
  const activation = decodeResearchCapitalBuildBinding(value.activation)
  if (authoredActivation === undefined || activation === undefined) {
    throw new Error(`${role} BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE has an invalid build binding`)
  }
  if (authoredActivation.imageRepository !== activation.imageRepository) {
    throw new Error(`${role} BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE changes image repository`)
  }
  return {
    schemaVersion: researchCapitalBuildLineageSchemaVersion,
    requestHash: value.requestHash,
    authoredActivation,
    activation,
  }
}

const researchCapitalBuildBindingMatches = (
  left: ResearchCapitalBuildBinding,
  right: ResearchCapitalBuildBinding,
): boolean =>
  left.sourceRevision === right.sourceRevision &&
  left.imageRepository === right.imageRepository &&
  left.imageDigest === right.imageDigest

const renderResearchCapitalBuildLineage = (lineage: ResearchCapitalBuildLineage): string =>
  JSON.stringify(JSON.stringify(lineage))

interface NativeExecutionManifests {
  readonly activation: string
  readonly activationPath: string
  readonly controller: string
  readonly controllerPath: string
  readonly sourceSha: string
  readonly digest: string
}

const nativeExecutionManifests = (
  options: UpdateBaynManifestOptions,
  candidateSourceSha: string,
  candidateDigest: string,
): NativeExecutionManifests | undefined => {
  const usesDefaultManifests =
    options.kustomizationPath === undefined &&
    options.deploymentPath === undefined &&
    options.applicationSetPath === undefined
  const controllerPath =
    options.executionControllerPath ??
    (usesDefaultManifests ? 'argocd/applications/bayn/execution-controller.yaml' : undefined)
  const activationPath =
    options.executionActivationPath ??
    (usesDefaultManifests ? 'argocd/applications/bayn/execution-activation.yaml' : undefined)
  if (controllerPath === undefined && activationPath === undefined) return undefined
  if (controllerPath === undefined || activationPath === undefined) {
    throw new Error('native execution controller and activation manifest paths must be provided together')
  }
  const controllerExists = existsSync(controllerPath)
  const activationExists = existsSync(activationPath)
  if (!controllerExists && !activationExists) return undefined
  if (!controllerExists || !activationExists) {
    throw new Error('native execution controller and activation manifests must exist together')
  }
  const controller = readFileSync(controllerPath, 'utf8')
  const activation = readFileSync(activationPath, 'utf8')
  const sourceSha = environmentValue(controller, 'BAYN_CODE_REVISION')
  const digest = environmentValue(controller, 'BAYN_IMAGE_DIGEST')
  if (
    environmentValue(activation, 'BAYN_CODE_REVISION') !== sourceSha ||
    environmentValue(activation, 'BAYN_IMAGE_DIGEST') !== digest
  ) {
    throw new Error('native execution controller and activation manifests have different immutable image bindings')
  }
  if (sourceSha !== candidateSourceSha || digest !== candidateDigest) {
    throw new Error('native execution controller is not bound to the candidate Bayn source and image')
  }
  return { activation, activationPath, controller, controllerPath, sourceSha, digest }
}

const activationGeneration = (sourceSha: string, digest: string, researchRequestHash?: string): string => {
  const binding =
    researchRequestHash === undefined
      ? ['bayn.execution-controller-activation.v2', baynExecutionControllerPlanHash, sourceSha, digest]
      : [
          'bayn.execution-controller-activation.v3',
          baynExecutionControllerPlanHash,
          sourceSha,
          digest,
          researchRequestHash,
        ]
  return createHash('sha256').update(binding.join('\0')).digest('hex')
}

const replaceEnvironmentValue = (manifest: string, name: string, value: string): string =>
  replaceExactlyOnce(
    manifest,
    new RegExp(`(            - name: ${name}\\n              value: )[^\\n]+`),
    `$1${value}`,
    `${name} value`,
  )

const updateNativeExecutionManifest = (
  manifest: string,
  options: UpdateBaynManifestOptions,
  candidateRuntime: BaynCandidateRuntime,
  previousPlanHash: string,
  previousSourceRevision: string,
  researchBuildLineage: ResearchCapitalBuildLineage | null,
): string => {
  let updated = replaceExactlyOnce(
    manifest,
    /(          image: registry\.ide-newton\.ts\.net\/lab\/bayn:)[^\n]+/,
    `$1sha-${options.sourceSha}@${options.digest}`,
    'native Bayn image',
  )
  updated = replaceEnvironmentValue(updated, 'BAYN_CODE_REVISION', options.sourceSha)
  updated = replaceEnvironmentValue(updated, 'BAYN_IMAGE_DIGEST', options.digest)
  updated = replaceEnvironmentValue(updated, 'BAYN_EXECUTION_PREVIOUS_PLAN_HASH', JSON.stringify(previousPlanHash))
  updated = replaceEnvironmentValue(updated, 'BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION', previousSourceRevision)
  updated = replaceEnvironmentValue(
    updated,
    'BAYN_STRATEGY_BEHAVIOR_HASH',
    JSON.stringify(options.strategyBehaviorHash),
  )
  updated = replaceEnvironmentValue(
    updated,
    'BAYN_STRATEGY_PARAMETER_HASH',
    JSON.stringify(options.strategyParameterHash),
  )
  for (const [name, value] of Object.entries(candidateRuntime)) {
    updated = replaceEnvironmentValue(updated, name, JSON.stringify(value))
  }
  if (researchBuildLineage !== null) {
    updated = replaceEnvironmentValue(
      updated,
      'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE',
      renderResearchCapitalBuildLineage(researchBuildLineage),
    )
  }
  return updated
}

const validateIsoDate = (name: string, value: string): void => {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!isoDatePattern.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid ${name}: ${value}`)
  }
}

const validateCandidateRuntime = (runtime: BaynCandidateRuntime): void => {
  if (!hashPattern.test(runtime.BAYN_SIGNAL_SNAPSHOT_ID)) {
    throw new Error(`invalid candidate Signal snapshot ID: ${runtime.BAYN_SIGNAL_SNAPSHOT_ID}`)
  }
  if (!tagPattern.test(runtime.BAYN_SIGNAL_CALENDAR_VERSION)) {
    throw new Error(`invalid candidate Signal calendar version: ${runtime.BAYN_SIGNAL_CALENDAR_VERSION}`)
  }
  validateIsoDate('candidate Signal publication date', runtime.BAYN_SIGNAL_PUBLICATION_ASOF)
  validateIsoDate('candidate Signal data start', runtime.BAYN_SIGNAL_DATA_START)
  validateIsoDate('candidate Signal data end', runtime.BAYN_SIGNAL_DATA_END)
  validateIsoDate('candidate Signal lookback start', runtime.BAYN_SIGNAL_LOOKBACK_START)
  validateIsoDate('candidate Signal evaluation start', runtime.BAYN_SIGNAL_EVALUATION_START)
  validateIsoDate('candidate Signal evaluation end', runtime.BAYN_SIGNAL_EVALUATION_END)
  if (
    runtime.BAYN_SIGNAL_DATA_END !== runtime.BAYN_SIGNAL_PUBLICATION_ASOF ||
    runtime.BAYN_SIGNAL_EVALUATION_END !== runtime.BAYN_SIGNAL_PUBLICATION_ASOF
  ) {
    throw new Error('candidate Signal data and evaluation end must equal publication date')
  }
  if (
    runtime.BAYN_SIGNAL_DATA_START > runtime.BAYN_SIGNAL_LOOKBACK_START ||
    runtime.BAYN_SIGNAL_LOOKBACK_START > runtime.BAYN_SIGNAL_EVALUATION_START ||
    runtime.BAYN_SIGNAL_EVALUATION_START > runtime.BAYN_SIGNAL_EVALUATION_END
  ) {
    throw new Error('candidate Signal bounds are not ordered')
  }
  if (!decimalPattern.test(runtime.BAYN_TIGERBEETLE_CLUSTER_ID)) {
    throw new Error(`invalid candidate TigerBeetle cluster ID: ${runtime.BAYN_TIGERBEETLE_CLUSTER_ID}`)
  }
  const clusterId = BigInt(runtime.BAYN_TIGERBEETLE_CLUSTER_ID)
  if (clusterId <= 0n || clusterId > maximumTigerBeetleClusterId) {
    throw new Error(`invalid candidate TigerBeetle cluster ID: ${runtime.BAYN_TIGERBEETLE_CLUSTER_ID}`)
  }
  if (!transportAddressesPattern.test(runtime.BAYN_TIGERBEETLE_ADDRESSES.trim())) {
    throw new Error(`invalid candidate TigerBeetle addresses: ${runtime.BAYN_TIGERBEETLE_ADDRESSES}`)
  }
  if (!decimalPattern.test(runtime.BAYN_TIGERBEETLE_LEDGER)) {
    throw new Error(`invalid candidate TigerBeetle ledger: ${runtime.BAYN_TIGERBEETLE_LEDGER}`)
  }
  const ledger = Number(runtime.BAYN_TIGERBEETLE_LEDGER)
  if (!Number.isSafeInteger(ledger) || ledger <= 0 || ledger > maximumTigerBeetleLedger) {
    throw new Error(`invalid candidate TigerBeetle ledger: ${runtime.BAYN_TIGERBEETLE_LEDGER}`)
  }
}

const qualificationRunIdFromDeployment = (deployment: string, role: 'candidate' | 'deployed'): string | null => {
  const pins = [...deployment.matchAll(new RegExp(qualificationPin.source, 'g'))]
  if (pins.length > 1) throw new Error(`expected at most one ${role} BAYN_QUALIFICATION_RUN_ID block`)
  if (pins.length === 0) return null
  const runId = environmentValue(deployment, 'BAYN_QUALIFICATION_RUN_ID')
  if (!hashPattern.test(runId)) throw new Error(`invalid ${role} BAYN_QUALIFICATION_RUN_ID`)
  return runId
}

const transitionQualificationPin = (deployment: string, qualificationRunId: string | null): string => {
  const withoutQualificationPin = deployment.replace(qualificationPin, '')
  if (qualificationRunId === null) return withoutQualificationPin
  const block =
    `            - name: BAYN_QUALIFICATION_RUN_ID\n` + `              value: ${JSON.stringify(qualificationRunId)}\n`
  return replaceExactlyOnce(
    withoutQualificationPin,
    /(            - name: BAYN_STRATEGY_PARAMETER_HASH\n              value: [^\n]+\n)/,
    `$1${block}`,
    'BAYN_STRATEGY_PARAMETER_HASH block',
  )
}

export const updateBaynManifests = (options: UpdateBaynManifestOptions): BaynManifestUpdate => {
  if (!sourceShaPattern.test(options.sourceSha)) throw new Error(`invalid source SHA: ${options.sourceSha}`)
  if (!tagPattern.test(options.tag)) throw new Error(`invalid image tag: ${options.tag}`)
  if (!digestPattern.test(options.digest)) throw new Error(`invalid image digest: ${options.digest}`)
  if (!hashPattern.test(options.strategyBehaviorHash)) {
    throw new Error(`invalid strategy behavior hash: ${options.strategyBehaviorHash}`)
  }
  if (!hashPattern.test(options.strategyParameterHash)) {
    throw new Error(`invalid strategy parameter hash: ${options.strategyParameterHash}`)
  }
  if (options.acceptedQualificationRunId !== undefined && !hashPattern.test(options.acceptedQualificationRunId)) {
    throw new Error(`invalid accepted qualification run ID: ${options.acceptedQualificationRunId}`)
  }
  if (options.researchLineageSourceSha !== undefined && !sourceShaPattern.test(options.researchLineageSourceSha)) {
    throw new Error(`invalid research lineage source SHA: ${options.researchLineageSourceSha}`)
  }
  if (Number.isNaN(Date.parse(options.rolloutTimestamp))) throw new Error('rollout timestamp must be ISO-8601')

  const kustomizationPath = options.kustomizationPath ?? 'argocd/applications/bayn/kustomization.yaml'
  const deploymentPath = options.deploymentPath ?? 'argocd/applications/bayn/deployment.yaml'
  const applicationSetPath = options.applicationSetPath ?? 'argocd/applicationsets/product.yaml'
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const deployment = readFileSync(deploymentPath, 'utf8')
  const deployedDeployment =
    options.deployedDeploymentPath === undefined ? deployment : readFileSync(options.deployedDeploymentPath, 'utf8')
  validateNativeBaynDeployment(deployment)
  validateNativeBaynDeployment(deployedDeployment)
  const deployedQualificationRunId = qualificationRunIdFromDeployment(deployedDeployment, 'deployed')
  qualificationRunIdFromDeployment(deployment, 'candidate')
  const hadQualificationPin = deployedQualificationRunId !== null
  const capitalActivationRequests = [...deployedDeployment.matchAll(new RegExp(capitalActivationRequest.source, 'g'))]
  if (capitalActivationRequests.length > 1) {
    throw new Error('expected at most one BAYN_CAPITAL_ACTIVATION_REQUEST block')
  }
  const hasCapitalActivationRequest = capitalActivationRequests.length === 1
  const deployedCapitalActivationKind = hasCapitalActivationRequest
    ? environmentValue(deployedDeployment, 'BAYN_CAPITAL_ACTIVATION_KIND')
    : null
  const capitalActivationKind = hasCapitalActivationRequest
    ? environmentValue(deployment, 'BAYN_CAPITAL_ACTIVATION_KIND')
    : null
  for (const [role, kind] of [
    ['deployed', deployedCapitalActivationKind],
    ['candidate', capitalActivationKind],
  ] as const) {
    if (kind !== null && kind !== 'ResearchCapitalActivationRequest' && kind !== researchCapitalBuildContinuation) {
      throw new Error(`invalid ${role} BAYN_CAPITAL_ACTIVATION_KIND: ${kind}`)
    }
  }
  const deployedRuntime = runtimeFromDeployment(deployedDeployment)
  const candidateManifestRuntime = runtimeFromDeployment(deployment)
  const candidateRuntime = options.candidateRuntime ?? candidateManifestRuntime
  validateCandidateRuntime(candidateRuntime)
  const deployedSourceSha = environmentValue(deployedDeployment, 'BAYN_CODE_REVISION')
  const deployedImageDigest = environmentValue(deployedDeployment, 'BAYN_IMAGE_DIGEST')
  const deployedBehaviorHash = environmentValue(deployedDeployment, 'BAYN_STRATEGY_BEHAVIOR_HASH')
  const deployedParameterHash = environmentValue(deployedDeployment, 'BAYN_STRATEGY_PARAMETER_HASH')
  const candidateDeploymentSourceSha = environmentValue(deployment, 'BAYN_CODE_REVISION')
  const candidateDeploymentImageDigest = environmentValue(deployment, 'BAYN_IMAGE_DIGEST')
  const candidateDeploymentBehaviorHash = environmentValue(deployment, 'BAYN_STRATEGY_BEHAVIOR_HASH')
  const candidateDeploymentParameterHash = environmentValue(deployment, 'BAYN_STRATEGY_PARAMETER_HASH')
  const deployedSnapshotId = environmentValue(deployedDeployment, 'BAYN_SIGNAL_SNAPSHOT_ID')
  const candidateSnapshotId = candidateRuntime.BAYN_SIGNAL_SNAPSHOT_ID
  const snapshotChanged = deployedSnapshotId !== candidateSnapshotId
  const qualificationBindingsMatch = qualificationIdentityNames.every(
    (name) => deployedRuntime[name] === candidateRuntime[name],
  )
  const candidateRuntimeMatchesDeployment = candidateRuntimeNames.every(
    (name) => deployedRuntime[name] === candidateRuntime[name],
  )
  const candidateRuntimeMatchesManifest = candidateRuntimeNames.every(
    (name) => candidateManifestRuntime[name] === candidateRuntime[name],
  )
  const strategyIdentityMatches =
    deployedBehaviorHash === options.strategyBehaviorHash && deployedParameterHash === options.strategyParameterHash
  const candidateStrategyIdentityMatches =
    candidateDeploymentBehaviorHash === options.strategyBehaviorHash &&
    candidateDeploymentParameterHash === options.strategyParameterHash
  const researchRequestIdentityMatches = researchRequestIdentityNames.every(
    (name) => environmentValue(deployedDeployment, name) === environmentValue(deployment, name),
  )
  const deployedBuildMatches = deployedSourceSha === options.sourceSha && deployedImageDigest === options.digest
  const acceptedQualificationRunId = options.acceptedQualificationRunId
  const acceptedRunAlreadyPinned =
    acceptedQualificationRunId !== undefined && deployedQualificationRunId === acceptedQualificationRunId
  const nativeExecution = nativeExecutionManifests(
    options,
    candidateDeploymentSourceSha,
    candidateDeploymentImageDigest,
  )
  const candidateImageRepository = environmentValue(deployment, 'BAYN_IMAGE_REPOSITORY')
  let researchBuildLineage: ResearchCapitalBuildLineage | null = null
  let researchRequestAuthoredForCandidate = false
  let researchRequestHashChanged = false
  if (capitalActivationKind === 'ResearchCapitalActivationRequest') {
    researchBuildLineage = researchCapitalBuildLineageFromManifest(deployment, 'candidate deployment')
    researchRequestHashChanged =
      deployedCapitalActivationKind !== 'ResearchCapitalActivationRequest' ||
      researchCapitalBuildLineageFromManifest(deployedDeployment, 'deployed deployment').requestHash !==
        researchBuildLineage.requestHash
    const candidateBinding = {
      sourceRevision: candidateDeploymentSourceSha,
      imageRepository: candidateImageRepository,
      imageDigest: candidateDeploymentImageDigest,
    }
    if (!researchCapitalBuildBindingMatches(researchBuildLineage.activation, candidateBinding)) {
      throw new Error('candidate research build lineage does not end at the manifest activation build')
    }
    researchRequestAuthoredForCandidate = researchCapitalBuildBindingMatches(researchBuildLineage.authoredActivation, {
      sourceRevision: options.sourceSha,
      imageRepository: candidateImageRepository,
      imageDigest: options.digest,
    })
    if (nativeExecution !== undefined) {
      const controllerLineage = researchCapitalBuildLineageFromManifest(
        nativeExecution.controller,
        'native execution controller',
      )
      const activationLineage = researchCapitalBuildLineageFromManifest(
        nativeExecution.activation,
        'native execution activation',
      )
      if (
        JSON.stringify(controllerLineage) !== JSON.stringify(researchBuildLineage) ||
        JSON.stringify(activationLineage) !== JSON.stringify(researchBuildLineage)
      ) {
        throw new Error('Bayn runtime manifests have different research build lineage')
      }
    }
    if (
      options.researchLineageSourceSha !== undefined &&
      options.researchLineageSourceSha !== researchBuildLineage.authoredActivation.sourceRevision
    ) {
      throw new Error('release ancestry proof does not start at the authored research activation')
    }
  } else if (options.researchLineageSourceSha !== undefined) {
    throw new Error('research lineage proof requires a raw research activation request')
  }
  if (acceptedQualificationRunId !== undefined && !acceptedRunAlreadyPinned && options.candidateRuntime === undefined) {
    throw new Error('installing an accepted qualification run requires an explicit candidate runtime')
  }
  if (acceptedRunAlreadyPinned && (!strategyIdentityMatches || !qualificationBindingsMatch)) {
    throw new Error('an accepted qualification pin cannot be rebound to different strategy or runtime identity')
  }
  if (acceptedQualificationRunId !== undefined && !acceptedRunAlreadyPinned) {
    if (hasCapitalActivationRequest) {
      throw new Error('qualification installation cannot reuse a configured capital activation request')
    }
    if (hadQualificationPin) {
      throw new Error('qualification installation requires an already-deployed unpinned runtime')
    }
    if (
      deployedSourceSha !== options.sourceSha ||
      deployedImageDigest !== options.digest ||
      !strategyIdentityMatches ||
      !candidateRuntimeMatchesDeployment
    ) {
      throw new Error('qualification installation must pin the exact deployed source, image, strategy, and runtime')
    }
  }
  const researchCapitalRelease =
    !hadQualificationPin && hasCapitalActivationRequest && acceptedQualificationRunId === undefined
  const unpinnedCandidateReplay =
    !hadQualificationPin && !hasCapitalActivationRequest && acceptedQualificationRunId === undefined
  if (
    unpinnedCandidateReplay &&
    (!deployedBuildMatches || !strategyIdentityMatches || !candidateRuntimeMatchesDeployment)
  ) {
    throw new Error('an unpinned qualification candidate is immutable until its terminal run is pinned')
  }
  let qualificationMode: BaynManifestUpdate['qualificationMode']
  if (researchCapitalRelease) {
    qualificationMode = 'research'
  } else if (acceptedQualificationRunId !== undefined && !acceptedRunAlreadyPinned) {
    qualificationMode = 'install'
  } else if (hadQualificationPin && strategyIdentityMatches && qualificationBindingsMatch) {
    qualificationMode = 'preserve'
  } else {
    qualificationMode = 'replace'
  }
  let candidateQualificationRunId: string | null = null
  if (qualificationMode === 'install') {
    if (acceptedQualificationRunId === undefined) throw new Error('accepted qualification run ID is missing')
    candidateQualificationRunId = acceptedQualificationRunId
  } else if (qualificationMode === 'preserve') {
    candidateQualificationRunId = deployedQualificationRunId
  }
  const updateDetails = {
    qualificationMode,
    hadQualificationPin,
    qualificationBindingsMatch,
    snapshotChanged,
    deployedQualificationRunId,
    candidateQualificationRunId,
    deployedSnapshotId,
    candidateSnapshotId,
    deployedSourceSha,
    deployedBehaviorHash,
    deployedParameterHash,
    candidateBehaviorHash: options.strategyBehaviorHash,
    candidateParameterHash: options.strategyParameterHash,
  } as const
  if (hadQualificationPin && !strategyIdentityMatches && qualificationBindingsMatch && !snapshotChanged) {
    return {
      promotionAction: 'hold',
      promotionReason: 'strategy-identity-change-requires-fresh-snapshot',
      ...updateDetails,
    }
  }
  if (
    researchCapitalRelease &&
    (capitalActivationKind === researchCapitalBuildContinuation
      ? !researchRequestIdentityMatches || !candidateStrategyIdentityMatches || !candidateRuntimeMatchesDeployment
      : (!researchRequestIdentityMatches && !(researchRequestAuthoredForCandidate && researchRequestHashChanged)) ||
        !candidateStrategyIdentityMatches ||
        !candidateRuntimeMatchesManifest ||
        ((candidateDeploymentSourceSha !== options.sourceSha || candidateDeploymentImageDigest !== options.digest) &&
          options.researchLineageSourceSha === undefined))
  ) {
    return {
      promotionAction: 'hold',
      promotionReason: 'research-capital-activation-refresh-required',
      ...updateDetails,
    }
  }
  if (qualificationMode === 'replace' && hadQualificationPin && !snapshotChanged) {
    throw new Error('qualification replacement requires a fresh BAYN_SIGNAL_SNAPSHOT_ID')
  }
  const promotedResearchBuildLineage =
    researchBuildLineage === null
      ? null
      : {
          ...researchBuildLineage,
          activation: {
            sourceRevision: options.sourceSha,
            imageRepository: candidateImageRepository,
            imageDigest: options.digest,
          },
        }
  const imageBlock =
    /(  - name: bayn-main\n    newName: registry\.ide-newton\.ts\.net\/lab\/bayn\n    newTag: )[^\n]+(?:\n    digest: [^\n]+)?/
  const updatedKustomization = replaceExactlyOnce(
    kustomization,
    imageBlock,
    `$1${JSON.stringify(options.tag)}\n    digest: ${options.digest}`,
    'Bayn image block',
  )

  let updatedDeployment = replaceExactlyOnce(
    deployment,
    /(            - name: BAYN_CODE_REVISION\n              value: )[^\n]+/,
    `$1${options.sourceSha}`,
    'BAYN_CODE_REVISION value',
  )
  updatedDeployment = replaceExactlyOnce(
    updatedDeployment,
    /(            - name: BAYN_IMAGE_DIGEST\n              value: )[^\n]+/,
    `$1${options.digest}`,
    'BAYN_IMAGE_DIGEST value',
  )
  updatedDeployment = replaceExactlyOnce(
    updatedDeployment,
    /(            - name: BAYN_STRATEGY_BEHAVIOR_HASH\n              value: )[^\n]+/,
    `$1${JSON.stringify(options.strategyBehaviorHash)}`,
    'BAYN_STRATEGY_BEHAVIOR_HASH value',
  )
  updatedDeployment = replaceExactlyOnce(
    updatedDeployment,
    /(            - name: BAYN_STRATEGY_PARAMETER_HASH\n              value: )[^\n]+/,
    `$1${JSON.stringify(options.strategyParameterHash)}`,
    'BAYN_STRATEGY_PARAMETER_HASH value',
  )
  if (nativeExecution !== undefined) {
    updatedDeployment = replaceEnvironmentValue(
      updatedDeployment,
      'BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH',
      JSON.stringify(baynExecutionControllerPlanHash),
    )
  }
  if (promotedResearchBuildLineage !== null) {
    updatedDeployment = replaceEnvironmentValue(
      updatedDeployment,
      'BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE',
      renderResearchCapitalBuildLineage(promotedResearchBuildLineage),
    )
  }
  updatedDeployment = transitionQualificationPin(updatedDeployment, candidateQualificationRunId)
  for (const [name, value] of Object.entries(candidateRuntime)) {
    updatedDeployment = replaceExactlyOnce(
      updatedDeployment,
      new RegExp(`(            - name: ${name}\\n              value: )[^\\n]+`),
      `$1${JSON.stringify(value)}`,
      `${name} value`,
    )
  }
  updatedDeployment = replaceExactlyOnce(
    updatedDeployment,
    /(        kubectl\.kubernetes\.io\/restartedAt: )[^\n]+/,
    `$1${JSON.stringify(options.rolloutTimestamp)}`,
    'Bayn rollout annotation',
  )

  const applicationSet = readFileSync(applicationSetPath, 'utf8')
  const updatedApplicationSet = replaceExactlyOnce(
    applicationSet,
    /(^ {14}- name: bayn\n(?:(?!^ {14}- name:)[\s\S])*?^ {16}enabled: )"(?:false|true)"/m,
    '$1"true"',
    'Bayn ApplicationSet enabled state',
  )

  let updatedExecutionController: string | undefined
  let updatedExecutionActivation: string | undefined
  if (nativeExecution !== undefined) {
    const deployedPlanHash = environmentValue(deployedDeployment, 'BAYN_EXPECTED_EXECUTION_CONTROLLER_PLAN_HASH')
    const previousPlanHash =
      deployedPlanHash === baynExecutionControllerPlanHash
        ? environmentValue(nativeExecution.controller, 'BAYN_EXECUTION_PREVIOUS_PLAN_HASH')
        : deployedPlanHash
    const previousSourceRevision =
      deployedPlanHash === baynExecutionControllerPlanHash
        ? environmentValue(nativeExecution.controller, 'BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION')
        : deployedSourceSha
    if (
      environmentValue(nativeExecution.activation, 'BAYN_EXECUTION_PREVIOUS_PLAN_HASH') !==
        environmentValue(nativeExecution.controller, 'BAYN_EXECUTION_PREVIOUS_PLAN_HASH') ||
      environmentValue(nativeExecution.activation, 'BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION') !==
        environmentValue(nativeExecution.controller, 'BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION')
    ) {
      throw new Error('native execution controller and activation manifests have different previous bindings')
    }
    updatedExecutionController = updateNativeExecutionManifest(
      nativeExecution.controller,
      options,
      candidateRuntime,
      previousPlanHash,
      previousSourceRevision,
      promotedResearchBuildLineage,
    )
    updatedExecutionActivation = updateNativeExecutionManifest(
      nativeExecution.activation,
      options,
      candidateRuntime,
      previousPlanHash,
      previousSourceRevision,
      promotedResearchBuildLineage,
    )
    updatedExecutionActivation = replaceExactlyOnce(
      updatedExecutionActivation,
      /(  name: bayn-execution-activate-)[0-9a-f]{12}/,
      `$1${options.sourceSha.slice(0, 12)}`,
      'Bayn activation Job name',
    )
    updatedExecutionActivation = replaceExactly(
      updatedExecutionActivation,
      /(    app\.kubernetes\.io\/version: )[0-9a-f]{12}/,
      `$1${options.sourceSha.slice(0, 12)}`,
      2,
      'Bayn activation version label',
    )
    updatedExecutionActivation = replaceExactlyOnce(
      updatedExecutionActivation,
      /(            - name: BAYN_EXECUTION_ACTIVATION_GENERATION\n(?:              # [^\n]+\n)*              value: )[^\n]+/,
      `$1${JSON.stringify(
        activationGeneration(options.sourceSha, options.digest, promotedResearchBuildLineage?.requestHash),
      )}`,
      'BAYN_EXECUTION_ACTIVATION_GENERATION value',
    )
  }

  writeFileSync(kustomizationPath, updatedKustomization)
  writeFileSync(deploymentPath, updatedDeployment)
  writeFileSync(applicationSetPath, updatedApplicationSet)
  if (nativeExecution !== undefined) {
    if (updatedExecutionController === undefined || updatedExecutionActivation === undefined) {
      throw new Error('native execution manifests were not rendered')
    }
    writeFileSync(nativeExecution.controllerPath, updatedExecutionController)
    writeFileSync(nativeExecution.activationPath, updatedExecutionActivation)
  }
  return {
    promotionAction: 'promote',
    promotionReason: 'eligible',
    ...updateDetails,
  }
}

const candidateRuntimeFlags = {
  '--signal-snapshot-id': 'BAYN_SIGNAL_SNAPSHOT_ID',
  '--signal-publication-asof': 'BAYN_SIGNAL_PUBLICATION_ASOF',
  '--signal-calendar-version': 'BAYN_SIGNAL_CALENDAR_VERSION',
  '--signal-data-start': 'BAYN_SIGNAL_DATA_START',
  '--signal-data-end': 'BAYN_SIGNAL_DATA_END',
  '--signal-lookback-start': 'BAYN_SIGNAL_LOOKBACK_START',
  '--signal-evaluation-start': 'BAYN_SIGNAL_EVALUATION_START',
  '--signal-evaluation-end': 'BAYN_SIGNAL_EVALUATION_END',
  '--tigerbeetle-cluster-id': 'BAYN_TIGERBEETLE_CLUSTER_ID',
  '--tigerbeetle-addresses': 'BAYN_TIGERBEETLE_ADDRESSES',
  '--tigerbeetle-ledger': 'BAYN_TIGERBEETLE_LEDGER',
} as const

const requiredFlags = [
  '--source-sha',
  '--tag',
  '--digest',
  '--strategy-behavior-hash',
  '--strategy-parameter-hash',
  '--rollout-timestamp',
] as const

export const parseUpdateBaynManifestArguments = (argumentsToParse: readonly string[]): UpdateBaynManifestOptions => {
  const values = new Map<string, string>()
  const allowedFlags = new Set([
    ...requiredFlags,
    ...Object.keys(candidateRuntimeFlags),
    '--accepted-qualification-run-id',
    '--deployed-deployment-path',
    '--research-lineage-source-sha',
  ])
  for (let index = 0; index < argumentsToParse.length; index += 2) {
    const flag = argumentsToParse[index]
    const value = argumentsToParse[index + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${flag ?? '<end>'}`)
    if (!allowedFlags.has(flag)) throw new Error(`unknown argument: ${flag}`)
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`)
    values.set(flag, value)
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim()
    if (!value) throw new Error(`${flag} is required`)
    return value
  }
  const providedCandidateFlags = Object.keys(candidateRuntimeFlags).filter((flag) => values.has(flag))
  let candidateRuntime: BaynCandidateRuntime | undefined
  if (providedCandidateFlags.length > 0) {
    const missingCandidateFlags = Object.keys(candidateRuntimeFlags).filter((flag) => !values.has(flag))
    if (missingCandidateFlags.length > 0) {
      throw new Error(`candidate runtime flags must be provided together; missing ${missingCandidateFlags.join(', ')}`)
    }
    candidateRuntime = {
      BAYN_SIGNAL_SNAPSHOT_ID: required('--signal-snapshot-id'),
      BAYN_SIGNAL_PUBLICATION_ASOF: required('--signal-publication-asof'),
      BAYN_SIGNAL_CALENDAR_VERSION: required('--signal-calendar-version'),
      BAYN_SIGNAL_DATA_START: required('--signal-data-start'),
      BAYN_SIGNAL_DATA_END: required('--signal-data-end'),
      BAYN_SIGNAL_LOOKBACK_START: required('--signal-lookback-start'),
      BAYN_SIGNAL_EVALUATION_START: required('--signal-evaluation-start'),
      BAYN_SIGNAL_EVALUATION_END: required('--signal-evaluation-end'),
      BAYN_TIGERBEETLE_CLUSTER_ID: required('--tigerbeetle-cluster-id'),
      BAYN_TIGERBEETLE_ADDRESSES: required('--tigerbeetle-addresses'),
      BAYN_TIGERBEETLE_LEDGER: required('--tigerbeetle-ledger'),
    }
  }
  const acceptedQualificationRunId = values.has('--accepted-qualification-run-id')
    ? required('--accepted-qualification-run-id')
    : undefined
  const deployedDeploymentPath = values.has('--deployed-deployment-path')
    ? required('--deployed-deployment-path')
    : undefined
  const researchLineageSourceSha = values.has('--research-lineage-source-sha')
    ? required('--research-lineage-source-sha')
    : undefined
  if (acceptedQualificationRunId !== undefined && candidateRuntime === undefined) {
    throw new Error('--accepted-qualification-run-id requires the complete candidate runtime')
  }
  return {
    sourceSha: required('--source-sha'),
    tag: required('--tag'),
    digest: required('--digest'),
    strategyBehaviorHash: required('--strategy-behavior-hash'),
    strategyParameterHash: required('--strategy-parameter-hash'),
    rolloutTimestamp: required('--rollout-timestamp'),
    ...(candidateRuntime === undefined ? {} : { candidateRuntime }),
    ...(acceptedQualificationRunId === undefined ? {} : { acceptedQualificationRunId }),
    ...(deployedDeploymentPath === undefined ? {} : { deployedDeploymentPath }),
    ...(researchLineageSourceSha === undefined ? {} : { researchLineageSourceSha }),
  }
}

if (import.meta.main) {
  try {
    process.stdout.write(JSON.stringify(updateBaynManifests(parseUpdateBaynManifestArguments(process.argv.slice(2)))))
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
