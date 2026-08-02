#!/usr/bin/env bun

import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

export type QualificationDormancyDecision =
  | {
      readonly status: 'dormant'
      readonly reason: string
      readonly candidateOrdinal: number | null
    }
  | {
      readonly status: 'ready'
      readonly reason: 'qualification-eligible'
      readonly candidateOrdinal: number
      readonly preregistrationSourceRevision: string
      readonly preregistrationBlobOid: string
    }

export type QualificationDormancyResult =
  | { readonly ok: true; readonly decision: QualificationDormancyDecision }
  | { readonly ok: false; readonly issue: { readonly path: string; readonly reason: string } }

type ServiceResult =
  | {
      readonly _tag: 'Success'
      readonly success: unknown
      readonly pipe: (...operations: readonly ((value: unknown) => unknown)[]) => unknown
    }
  | {
      readonly _tag: 'Failure'
      readonly failure: unknown
      readonly pipe: (...operations: readonly ((value: unknown) => unknown)[]) => unknown
    }

const serviceResult = (tag: 'Success' | 'Failure', value: unknown): ServiceResult => {
  const result = {
    _tag: tag,
    ...(tag === 'Success' ? { success: value } : { failure: value }),
  } as Omit<ServiceResult, 'pipe'>
  return {
    ...result,
    pipe: (...operations) => operations.reduce((current, operation) => operation(current), result),
  } as ServiceResult
}

const serviceSuccess = (value: unknown): ServiceResult => serviceResult('Success', value)
const serviceFailure = (value: unknown): ServiceResult => serviceResult('Failure', value)
const serviceFailureResult = (value: unknown): value is Extract<ServiceResult, { readonly _tag: 'Failure' }> =>
  typeof value === 'object' && value !== null && (value as { readonly _tag?: unknown })._tag === 'Failure'

const serviceResultMap = (value: ServiceResult, operation: (value: unknown) => unknown): ServiceResult =>
  serviceFailureResult(value) ? value : serviceSuccess(operation(value.success))

const serviceResultFlatMap = (value: ServiceResult, operation: (value: unknown) => ServiceResult): ServiceResult =>
  serviceFailureResult(value) ? value : operation(value.success)

const serviceResultMapError = (value: ServiceResult, operation: (value: unknown) => unknown): ServiceResult =>
  serviceFailureResult(value) ? serviceFailure(operation(value.failure)) : value

const serviceResultOperator = (
  operation: (value: ServiceResult, mapper: (value: unknown) => unknown) => ServiceResult,
  valueOrMapper: unknown,
  mapper?: (value: unknown) => unknown,
): ServiceResult | ((value: ServiceResult) => ServiceResult) =>
  mapper === undefined && typeof valueOrMapper === 'function'
    ? (value: ServiceResult) => operation(value, valueOrMapper as (value: unknown) => unknown)
    : operation(valueOrMapper as ServiceResult, mapper as (value: unknown) => unknown)

const serviceResultAll = (value: unknown): ServiceResult => {
  if (Array.isArray(value)) {
    const values: unknown[] = []
    for (const item of value) {
      if (serviceFailureResult(item)) return item
      values.push((item as Extract<ServiceResult, { readonly _tag: 'Success' }>).success)
    }
    return serviceSuccess(values)
  }
  if (typeof value !== 'object' || value === null) return serviceSuccess(value)
  const values: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (serviceFailureResult(item)) return item
    values[key] = (item as Extract<ServiceResult, { readonly _tag: 'Success' }>).success
  }
  return serviceSuccess(values)
}

const serviceResultTry = (value: unknown): ServiceResult => {
  try {
    return serviceSuccess(
      typeof value === 'function' ? (value as () => unknown)() : (value as { readonly try: () => unknown }).try(),
    )
  } catch (cause) {
    return serviceFailure(
      typeof value === 'function' || typeof (value as { readonly catch?: unknown }).catch !== 'function'
        ? cause
        : (value as { readonly catch: (cause: unknown) => unknown }).catch(cause),
    )
  }
}

const serviceResultGetOrThrowWith = (value: ServiceResult, onFailure: (failure: unknown) => unknown): unknown => {
  if (serviceFailureResult(value)) throw onFailure(value.failure)
  return value.success
}

/**
 * Minimal runtime surface used when filtered scripts CI has no Bayn dependency install. The service lifecycle module
 * remains the only implementation of qualification state validation and decision policy.
 */
export const Result = {
  fail: serviceFailure,
  succeed: serviceSuccess,
  isFailure: serviceFailureResult,
  isSuccess: (value: unknown): value is Extract<ServiceResult, { readonly _tag: 'Success' }> =>
    !serviceFailureResult(value),
  map: (valueOrMapper: unknown, mapper?: (value: unknown) => unknown) =>
    serviceResultOperator(serviceResultMap, valueOrMapper, mapper),
  flatMap: (valueOrMapper: unknown, mapper?: (value: unknown) => ServiceResult) =>
    serviceResultOperator(serviceResultFlatMap, valueOrMapper, mapper),
  mapError: (valueOrMapper: unknown, mapper?: (value: unknown) => unknown) =>
    serviceResultOperator(serviceResultMapError, valueOrMapper, mapper),
  all: serviceResultAll,
  try: serviceResultTry,
  getOrThrowWith: serviceResultGetOrThrowWith,
} as const

const schemaNode = (): Record<string, unknown> & ((...arguments_: readonly unknown[]) => unknown) => {
  const node = ((..._arguments: readonly unknown[]) => schemaNode()) as Record<string, unknown> &
    ((...arguments_: readonly unknown[]) => unknown)
  node.fields = {}
  node.check = () => node
  node.pipe = () => node
  return node
}

export const Schema = new Proxy(schemaNode(), {
  get: (_target, property) =>
    property === 'decodeUnknownResult' ? () => (value: unknown) => serviceSuccess(value) : schemaNode(),
})

const taggedError = (tag: string) =>
  class extends Error {
    readonly _tag = tag

    constructor(fields: Record<string, unknown>) {
      super(typeof fields.message === 'string' ? fields.message : tag)
      Object.assign(this, fields)
    }
  }

export const Data = { TaggedError: taggedError }
export const Effect = new Proxy(
  {},
  {
    get: (_target, property) => (property === 'fromResult' ? () => ({ pipe: () => ({}) }) : () => ({})),
  },
)
export const Chunk = {}
type Pipe = (value: unknown, ...operations: readonly ((value: unknown) => unknown)[]) => unknown
export const pipe: Pipe = (value, ...operations) => operations.reduce((current, operation) => operation(current), value)

const trialHistoryRelativePath = 'services/bayn/src/candidate-development-trials/frozen-lineage.ts'
const lifecycleRelativePath = 'services/bayn/src/candidate-development-trials/qualification-dormancy.ts'
const packageRoot = resolve(import.meta.dir, '../../../..')
const baynNodeModules = resolve(packageRoot, 'services/bayn/node_modules')
const baynEffectLink = resolve(baynNodeModules, 'effect')
const lifecycleEffectVersion = '4.0.0-beta.102'
const verifierPath = resolve(import.meta.dir, 'verify-qualification-dormancy.ts')

const packageVersion = async (packageRoot: string): Promise<string | undefined> => {
  try {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      readonly name?: unknown
      readonly version?: unknown
    }
    return manifest.name === 'effect' && typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

const lifecycleEffectPackage = async (): Promise<string | undefined> => {
  const candidates = [
    resolve(packageRoot, `node_modules/.bun/effect@${lifecycleEffectVersion}/node_modules/effect`),
    baynEffectLink,
    resolve(packageRoot, 'node_modules/effect'),
  ]
  for (const candidate of candidates) {
    if ((await packageVersion(candidate)) === lifecycleEffectVersion) return candidate
  }
  return undefined
}

const lifecycleEffect = await lifecycleEffectPackage()
let temporaryRuntimeActive = false

interface LifecycleModule {
  readonly decideQualificationDormancy: (value: unknown) => QualificationDormancyResult
}

const withLifecycleRuntime = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  if (temporaryRuntimeActive) return operation()
  if (existsSync(baynEffectLink)) {
    if ((await packageVersion(baynEffectLink)) !== lifecycleEffectVersion) {
      throw new Error('conflicting Effect runtime at services/bayn/node_modules/effect')
    }
    return operation()
  }

  temporaryRuntimeActive = true
  try {
    await mkdir(baynNodeModules, { recursive: true })
    if (lifecycleEffect === undefined) {
      await rm(baynEffectLink, { force: true })
      await mkdir(resolve(baynEffectLink, 'dist/esm'), { recursive: true })
      await writeFile(
        resolve(baynEffectLink, 'package.json'),
        JSON.stringify({
          name: 'effect',
          version: lifecycleEffectVersion,
          type: 'module',
          exports: { '.': './dist/esm/index.js' },
        }),
        'utf8',
      )
      await symlink(verifierPath, resolve(baynEffectLink, 'dist/esm/index.js'))
    } else {
      await symlink(lifecycleEffect, baynEffectLink)
    }
    return await operation()
  } finally {
    temporaryRuntimeActive = false
    await rm(baynEffectLink, { recursive: lifecycleEffect === undefined, force: true })
  }
}

const loadLifecycleModule = async (): Promise<LifecycleModule> =>
  withLifecycleRuntime(
    async () => (await import(pathToFileURL(resolve(packageRoot, lifecycleRelativePath)).href)) as LifecycleModule,
  )

let lifecycleModulePromise: Promise<LifecycleModule> | undefined

const lifecycleModule = (): Promise<LifecycleModule> => (lifecycleModulePromise ??= loadLifecycleModule())

export const evaluateQualificationDormancy = async (value: unknown): Promise<QualificationDormancyResult> =>
  (await lifecycleModule()).decideQualificationDormancy(value)

interface FrozenLineageModule {
  readonly frozenCandidateDevelopmentTrialHistory: unknown
}

/**
 * The lifecycle module owns decoding and fail-closed state validation. The adapter treats only the canonical `ready`/
 * `qualification-eligible` result as runnable; reviewed-only states remain dormant.
 */
export type QualificationLifecycleDecision = QualificationDormancyDecision

type QualificationLifecycleResult = QualificationDormancyResult

const decideQualificationLifecycle = async (history: unknown): Promise<QualificationLifecycleResult> =>
  evaluateQualificationDormancy(history)

const loadFrozenTrialHistory = async (repositoryRoot: string): Promise<unknown> => {
  const modulePath = resolve(repositoryRoot, trialHistoryRelativePath)
  const loaded = (await import(pathToFileURL(modulePath).href)) as FrozenLineageModule
  return loaded.frozenCandidateDevelopmentTrialHistory
}

export const verifyQualificationDormancy = async (repositoryRoot: string): Promise<QualificationLifecycleDecision> => {
  return withLifecycleRuntime(async () => {
    const result = await decideQualificationLifecycle(await loadFrozenTrialHistory(repositoryRoot))
    if (!result.ok) throw new Error(`${result.issue.path}: ${result.issue.reason}`)
    return result.decision
  })
}

export interface QualificationWorkflowOutputs {
  readonly eligible: 'true' | 'false'
  readonly dormant: 'true' | 'false'
  readonly reason: string
  readonly candidateOrdinal: string
}

export const qualificationWorkflowOutputs = (
  decision: QualificationLifecycleDecision,
): QualificationWorkflowOutputs => {
  const eligible = decision.status === 'ready' && decision.reason === 'qualification-eligible'
  return {
    eligible: eligible ? 'true' : 'false',
    dormant: eligible ? 'false' : 'true',
    reason: decision.reason,
    candidateOrdinal: decision.candidateOrdinal === null ? '' : String(decision.candidateOrdinal),
  }
}

const argument = (name: string): string => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

const run = async (): Promise<void> => {
  const decision = await verifyQualificationDormancy(argument('--repository-root'))
  const outputs = qualificationWorkflowOutputs(decision)
  await appendFile(
    argument('--github-output'),
    [
      `eligible=${outputs.eligible}`,
      `dormant=${outputs.dormant}`,
      `reason=${outputs.reason}`,
      `candidate_ordinal=${outputs.candidateOrdinal}`,
      '',
    ].join('\n'),
    'utf8',
  )
  process.stdout.write(`BAYN_QUALIFICATION_DORMANCY=${JSON.stringify(decision)}\n`)
}

if (import.meta.main) {
  await run().catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    process.stderr.write(`qualification dormancy verification failed: ${message}\n`)
    process.exitCode = 1
  })
}
