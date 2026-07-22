#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const digestPattern = /^sha256:[0-9a-f]{64}$/
const hashPattern = /^[0-9a-f]{64}$/
const sourceShaPattern = /^[0-9a-f]{40}$/
const tagPattern = /^[A-Za-z0-9._-]{1,128}$/
const currentQualificationIdentity = {
  BAYN_SIGNAL_SNAPSHOT_ID: '0945e3331d67437a072d5eb33f65e469b9883a5e762e29e80f7acb389864c79f',
  BAYN_SIGNAL_PUBLICATION_ASOF: '2026-07-22',
  BAYN_SIGNAL_CALENDAR_VERSION: 'alpaca-us-equity-calendar-v1',
  BAYN_SIGNAL_DATA_START: '2022-01-27',
  BAYN_SIGNAL_DATA_END: '2026-07-22',
  BAYN_SIGNAL_LOOKBACK_START: '2022-01-27',
  BAYN_SIGNAL_EVALUATION_START: '2023-01-30',
  BAYN_SIGNAL_EVALUATION_END: '2026-07-22',
  BAYN_TIGERBEETLE_CLUSTER_ID: '122731676035874920802382025803517750735',
  BAYN_TIGERBEETLE_LEDGER: '7001',
} as const

const currentTransportConfiguration = {
  BAYN_TIGERBEETLE_ADDRESSES:
    'ledger-0.ledger-headless.bayn.svc.cluster.local:3000,ledger-1.ledger-headless.bayn.svc.cluster.local:3000,ledger-2.ledger-headless.bayn.svc.cluster.local:3000',
} as const

const currentRuntimeConfiguration = {
  ...currentQualificationIdentity,
  ...currentTransportConfiguration,
} as const

export interface UpdateBaynManifestOptions {
  readonly sourceSha: string
  readonly tag: string
  readonly digest: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly rolloutTimestamp: string
  readonly kustomizationPath?: string
  readonly deploymentPath?: string
  readonly applicationSetPath?: string
}

export interface BaynManifestUpdate {
  readonly qualificationMode: 'preserve' | 'replace'
  readonly hadQualificationPin: boolean
  readonly qualificationBindingsMatch: boolean
  readonly snapshotChanged: boolean
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
const qualificationDossierGenerator =
  /  - name: bayn-qualification-dossier\n    files:\n      - qualification-dossier\.json=qualification-dossiers\/[0-9a-f]{64}\.json\n/
const qualificationDossierMount =
  /            - name: qualification-dossier\n              mountPath: \/var\/run\/bayn\/qualification\n              readOnly: true\n/
const qualificationDossierVolume =
  /        - name: qualification-dossier\n          configMap:\n            name: bayn-qualification-dossier\n            defaultMode: 0444\n            items:\n              - key: qualification-dossier\.json\n                path: qualification-dossier\.json\n/

const matchCount = (source: string, pattern: RegExp): number =>
  [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].length

const transitionQualificationPin = (
  deployment: string,
  mode: 'preserve' | 'replace',
  hadQualificationPin: boolean,
): string => {
  if (mode === 'preserve') {
    if (!hadQualificationPin) throw new Error('cannot preserve a missing BAYN_QUALIFICATION_RUN_ID block')
    return deployment
  }
  return hadQualificationPin ? deployment.replace(qualificationPin, '') : deployment
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
  if (Number.isNaN(Date.parse(options.rolloutTimestamp))) throw new Error('rollout timestamp must be ISO-8601')

  const kustomizationPath = options.kustomizationPath ?? 'argocd/applications/bayn/kustomization.yaml'
  const deploymentPath = options.deploymentPath ?? 'argocd/applications/bayn/deployment.yaml'
  const applicationSetPath = options.applicationSetPath ?? 'argocd/applicationsets/product.yaml'
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const deployment = readFileSync(deploymentPath, 'utf8')
  const qualificationPins = [...deployment.matchAll(new RegExp(qualificationPin.source, 'g'))]
  if (qualificationPins.length > 1) throw new Error('expected at most one BAYN_QUALIFICATION_RUN_ID block')
  const hadQualificationPin = qualificationPins.length === 1
  const dossierPartCounts = [
    matchCount(kustomization, qualificationDossierGenerator),
    matchCount(deployment, qualificationDossierMount),
    matchCount(deployment, qualificationDossierVolume),
  ]
  if (dossierPartCounts.some((count) => count > 1) || new Set(dossierPartCounts).size !== 1) {
    throw new Error('qualification dossier generator, mount, and volume must occur together at most once')
  }
  const hadQualificationDossier = dossierPartCounts[0] === 1
  if (hadQualificationDossier !== hadQualificationPin) {
    throw new Error('qualification pin and dossier must occur together')
  }
  const deployedSourceSha = environmentValue(deployment, 'BAYN_CODE_REVISION')
  const deployedBehaviorHash = environmentValue(deployment, 'BAYN_STRATEGY_BEHAVIOR_HASH')
  const deployedParameterHash = environmentValue(deployment, 'BAYN_STRATEGY_PARAMETER_HASH')
  const deployedSnapshotId = environmentValue(deployment, 'BAYN_SIGNAL_SNAPSHOT_ID')
  const candidateSnapshotId = currentRuntimeConfiguration.BAYN_SIGNAL_SNAPSHOT_ID
  const snapshotChanged = deployedSnapshotId !== candidateSnapshotId
  const qualificationBindingsMatch = Object.entries(currentQualificationIdentity).every(
    ([name, value]) => environmentValue(deployment, name) === value,
  )
  const strategyIdentityMatches =
    deployedBehaviorHash === options.strategyBehaviorHash && deployedParameterHash === options.strategyParameterHash
  const qualificationMode =
    hadQualificationPin && strategyIdentityMatches && qualificationBindingsMatch ? 'preserve' : 'replace'
  if (qualificationMode === 'replace' && hadQualificationPin && !snapshotChanged) {
    throw new Error('qualification replacement requires a fresh BAYN_SIGNAL_SNAPSHOT_ID')
  }
  if (!hadQualificationPin && !snapshotChanged && deployedSourceSha !== options.sourceSha) {
    throw new Error('an unpinned qualification snapshot cannot accept a second source release')
  }
  const imageBlock =
    /(  - name: registry\.ide-newton\.ts\.net\/lab\/bayn\n    newName: registry\.ide-newton\.ts\.net\/lab\/bayn\n    newTag: )[^\n]+(?:\n    digest: [^\n]+)?/
  let updatedKustomization = replaceExactlyOnce(
    kustomization,
    imageBlock,
    `$1${JSON.stringify(options.tag)}\n    digest: ${options.digest}`,
    'Bayn image block',
  )
  if (qualificationMode === 'replace' && hadQualificationDossier) {
    updatedKustomization = updatedKustomization.replace(qualificationDossierGenerator, '')
  }

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
  updatedDeployment = transitionQualificationPin(updatedDeployment, qualificationMode, hadQualificationPin)
  if (qualificationMode === 'replace' && hadQualificationDossier) {
    updatedDeployment = updatedDeployment.replace(qualificationDossierMount, '').replace(qualificationDossierVolume, '')
  }
  for (const [name, value] of Object.entries(currentRuntimeConfiguration)) {
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
    qualificationMode,
    hadQualificationPin,
    qualificationBindingsMatch,
    snapshotChanged,
    deployedSnapshotId,
    candidateSnapshotId,
    deployedSourceSha,
    deployedBehaviorHash,
    deployedParameterHash,
    candidateBehaviorHash: options.strategyBehaviorHash,
    candidateParameterHash: options.strategyParameterHash,
  }
}

const parseArguments = (argumentsToParse: readonly string[]): UpdateBaynManifestOptions => {
  const values = new Map<string, string>()
  for (let index = 0; index < argumentsToParse.length; index += 2) {
    const flag = argumentsToParse[index]
    const value = argumentsToParse[index + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${flag ?? '<end>'}`)
    values.set(flag, value)
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim()
    if (!value) throw new Error(`${flag} is required`)
    return value
  }
  return {
    sourceSha: required('--source-sha'),
    tag: required('--tag'),
    digest: required('--digest'),
    strategyBehaviorHash: required('--strategy-behavior-hash'),
    strategyParameterHash: required('--strategy-parameter-hash'),
    rolloutTimestamp: required('--rollout-timestamp'),
  }
}

if (import.meta.main) {
  try {
    process.stdout.write(JSON.stringify(updateBaynManifests(parseArguments(process.argv.slice(2)))))
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
