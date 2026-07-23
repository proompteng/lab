#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const digestPattern = /^sha256:[0-9a-f]{64}$/
const hashPattern = /^[0-9a-f]{64}$/
const sourceShaPattern = /^[0-9a-f]{40}$/
const tagPattern = /^[A-Za-z0-9._-]{1,128}$/
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/
const decimalPattern = /^[0-9]+$/
const transportAddressesPattern = /^[A-Za-z0-9.[\]:_-]+(?:[ \t]*,[ \t]*[A-Za-z0-9.[\]:_-]+)*$/
const maximumTigerBeetleClusterId = (1n << 128n) - 1n
const maximumTigerBeetleLedger = 2 ** 32 - 1

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
  readonly kustomizationPath?: string
  readonly deploymentPath?: string
  readonly applicationSetPath?: string
}

export interface BaynManifestUpdate {
  readonly promotionAction: 'promote' | 'hold'
  readonly promotionReason: 'eligible' | 'strategy-identity-change-requires-fresh-snapshot'
  readonly qualificationMode: 'preserve' | 'replace' | 'install'
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

const environmentValue = (deployment: string, name: string): string => {
  const pattern = new RegExp(`            - name: ${name}\\n              value: ([^\\n]+)\\n`, 'g')
  const matches = [...deployment.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`expected exactly one ${name} value`)
  const value = matches[0]?.[1]?.trim()
  if (value === undefined) throw new Error(`missing ${name} value`)
  return value.startsWith('"') ? String(JSON.parse(value)) : value
}

const qualificationPin = /            - name: BAYN_QUALIFICATION_RUN_ID\n              value: [^\n]+\n/
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

const transitionQualificationPin = (
  deployment: string,
  mode: 'preserve' | 'replace' | 'install',
  hadQualificationPin: boolean,
  acceptedQualificationRunId: string | undefined,
): string => {
  if (mode === 'preserve') {
    if (!hadQualificationPin) throw new Error('cannot preserve a missing BAYN_QUALIFICATION_RUN_ID block')
    return deployment
  }
  if (mode === 'replace') return hadQualificationPin ? deployment.replace(qualificationPin, '') : deployment
  if (acceptedQualificationRunId === undefined) {
    throw new Error('cannot install a missing accepted qualification run ID')
  }
  const block =
    `            - name: BAYN_QUALIFICATION_RUN_ID\n` +
    `              value: ${JSON.stringify(acceptedQualificationRunId)}\n`
  if (hadQualificationPin) return deployment.replace(qualificationPin, block)
  return replaceExactlyOnce(
    deployment,
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
  if (Number.isNaN(Date.parse(options.rolloutTimestamp))) throw new Error('rollout timestamp must be ISO-8601')

  const kustomizationPath = options.kustomizationPath ?? 'argocd/applications/bayn/kustomization.yaml'
  const deploymentPath = options.deploymentPath ?? 'argocd/applications/bayn/deployment.yaml'
  const applicationSetPath = options.applicationSetPath ?? 'argocd/applicationsets/product.yaml'
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const deployment = readFileSync(deploymentPath, 'utf8')
  const qualificationPins = [...deployment.matchAll(new RegExp(qualificationPin.source, 'g'))]
  if (qualificationPins.length > 1) throw new Error('expected at most one BAYN_QUALIFICATION_RUN_ID block')
  const hadQualificationPin = qualificationPins.length === 1
  const deployedQualificationRunId = hadQualificationPin
    ? environmentValue(deployment, 'BAYN_QUALIFICATION_RUN_ID')
    : null
  if (deployedQualificationRunId !== null && !hashPattern.test(deployedQualificationRunId)) {
    throw new Error('invalid deployed BAYN_QUALIFICATION_RUN_ID')
  }
  const deployedRuntime = runtimeFromDeployment(deployment)
  const candidateRuntime = options.candidateRuntime ?? deployedRuntime
  validateCandidateRuntime(candidateRuntime)
  const deployedSourceSha = environmentValue(deployment, 'BAYN_CODE_REVISION')
  const deployedImageDigest = environmentValue(deployment, 'BAYN_IMAGE_DIGEST')
  const deployedBehaviorHash = environmentValue(deployment, 'BAYN_STRATEGY_BEHAVIOR_HASH')
  const deployedParameterHash = environmentValue(deployment, 'BAYN_STRATEGY_PARAMETER_HASH')
  const deployedSnapshotId = environmentValue(deployment, 'BAYN_SIGNAL_SNAPSHOT_ID')
  const candidateSnapshotId = candidateRuntime.BAYN_SIGNAL_SNAPSHOT_ID
  const snapshotChanged = deployedSnapshotId !== candidateSnapshotId
  const qualificationBindingsMatch = qualificationIdentityNames.every(
    (name) => deployedRuntime[name] === candidateRuntime[name],
  )
  const candidateRuntimeMatchesDeployment = candidateRuntimeNames.every(
    (name) => deployedRuntime[name] === candidateRuntime[name],
  )
  const strategyIdentityMatches =
    deployedBehaviorHash === options.strategyBehaviorHash && deployedParameterHash === options.strategyParameterHash
  const acceptedQualificationRunId = options.acceptedQualificationRunId
  const acceptedRunAlreadyPinned =
    acceptedQualificationRunId !== undefined && deployedQualificationRunId === acceptedQualificationRunId
  if (acceptedQualificationRunId !== undefined && !acceptedRunAlreadyPinned && options.candidateRuntime === undefined) {
    throw new Error('installing an accepted qualification run requires an explicit candidate runtime')
  }
  if (acceptedRunAlreadyPinned && (!strategyIdentityMatches || !qualificationBindingsMatch)) {
    throw new Error('an accepted qualification pin cannot be rebound to different strategy or runtime identity')
  }
  if (acceptedQualificationRunId !== undefined && !acceptedRunAlreadyPinned) {
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
  const unpinnedCandidateReplay = !hadQualificationPin && acceptedQualificationRunId === undefined
  if (
    unpinnedCandidateReplay &&
    (deployedSourceSha !== options.sourceSha ||
      deployedImageDigest !== options.digest ||
      !strategyIdentityMatches ||
      !candidateRuntimeMatchesDeployment)
  ) {
    throw new Error('an unpinned qualification candidate is immutable until its terminal run is pinned')
  }
  let qualificationMode: BaynManifestUpdate['qualificationMode']
  if (acceptedQualificationRunId !== undefined && !acceptedRunAlreadyPinned) {
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
  if (qualificationMode === 'replace' && hadQualificationPin && !snapshotChanged) {
    throw new Error('qualification replacement requires a fresh BAYN_SIGNAL_SNAPSHOT_ID')
  }
  if (unpinnedCandidateReplay) {
    return {
      promotionAction: 'promote',
      promotionReason: 'eligible',
      ...updateDetails,
    }
  }
  const imageBlock =
    /(  - name: registry\.ide-newton\.ts\.net\/lab\/bayn\n    newName: registry\.ide-newton\.ts\.net\/lab\/bayn\n    newTag: )[^\n]+(?:\n    digest: [^\n]+)?/
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
  updatedDeployment = transitionQualificationPin(
    updatedDeployment,
    qualificationMode,
    hadQualificationPin,
    acceptedQualificationRunId,
  )
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

  writeFileSync(kustomizationPath, updatedKustomization)
  writeFileSync(deploymentPath, updatedDeployment)
  writeFileSync(applicationSetPath, updatedApplicationSet)
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
