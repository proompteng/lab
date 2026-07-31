import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import * as vm from 'node:vm'

import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, Layer, Logger, Option, Ref, Result } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import type { ApplicationPlanFor } from './app'
import { embeddedBuildMetadata } from './build'
import {
  type CandidateDevelopmentNextPreregistration,
  frozenCandidateDevelopmentTrialHistory,
} from './candidate-development-calendar'
import {
  validateCandidateDevelopmentPreregistrationDocument,
  verifyCandidateDevelopmentPreregistrationLineage,
  verifyCandidateDevelopmentPreregistrationModuleNovelty,
  verifyCandidateDevelopmentRepositoryIntegrity,
} from './candidate-development-command'
import { EvidenceStore, type EvidenceStoreService, type QualificationRecord } from './db/evidence-store'
import {
  ApplicationPlatformLive,
  ClickHouseClientResourceLive,
  EvidenceStoreResourceLive,
  JournalResourceLive,
  loadApplicationPlan,
  MarketDataResourceLive,
  PostgresClientResourceLive,
} from './entrypoint'
import { canonicalHashV1Result } from './hash'
import { Journal, type JournalService } from './ledger'
import { MarketData, type MarketDataInspection, type MarketDataService } from './market-data'
import { sqlResource } from './operations'
import { collectQualificationAuditReport } from './qualification-audit-command'
import {
  verifyQualificationCandidateBinding,
  type QualificationCandidateBindingReceipt,
} from './qualification-candidate-command'
import type { QualificationAuditReport } from './audit/audit'
import { initialState } from './runtime-state'
import { runStartup } from './startup'

const sha40 = /^[0-9a-f]{40}$/
const sha64 = /^[0-9a-f]{64}$/
const imageDigest = /^sha256:[0-9a-f]{64}$/
const maximumGitOutputBytes = 16 * 1024 * 1024
const defaultOperationTimeoutMs = 60_000
const defaultAuditReplicaUrls = [
  'http://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123',
  'http://chi-torghut-clickhouse-default-0-1.torghut.svc.cluster.local:8123',
] as const
const candidateArtifactSchemaVersion = 'bayn.candidate-development-artifact.v1'
const candidateStrategyProtocolSchemaVersion = 'bayn.candidate-development-strategy-protocol.v2'
const candidateMarketDataContractSchemaVersion = 'bayn.candidate-development-market-data-contract.v1'
const candidateDefinitionTimeoutMs = 10_000
const forbiddenCandidateDefinitionIdentifiers = new Set([
  'Atomics',
  'Bun',
  'Date',
  'EventSource',
  'FinalizationRegistry',
  'Function',
  'Intl',
  'Loader',
  'Promise',
  'ShadowRealm',
  'SharedArrayBuffer',
  'SharedWorker',
  'Temporal',
  'WebAssembly',
  'WebSocket',
  'WeakRef',
  'Worker',
  'XMLHttpRequest',
  'async',
  'await',
  'console',
  'crypto',
  'eval',
  'fetch',
  'import',
  'localeCompare',
  'module',
  'navigator',
  'performance',
  'process',
  'queueMicrotask',
  'require',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleUpperCase',
])

export class QualificationCollectorError extends Data.TaggedError('QualificationCollectorError')<{
  readonly phase: 'audit' | 'candidate' | 'configuration' | 'eligibility' | 'execution' | 'repository' | 'wiring'
  readonly code: string
  readonly message: string
  readonly cause?: unknown
}> {}

const collectorError = (
  phase: QualificationCollectorError['phase'],
  code: string,
  message: string,
  cause?: unknown,
): QualificationCollectorError => new QualificationCollectorError({ phase, code, message, cause })

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const candidateDefinitionIdentifierIssues = (source: string): readonly string[] => {
  const issues: string[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (character === "'" || character === '"') {
      const quote = character
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') index += 2
        else if (source[index] === quote) {
          index += 1
          break
        } else index += 1
      }
      continue
    }
    if (character === '`') {
      issues.push('template-literal')
      break
    }
    if (character === '/' && next === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index + 1 < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (character !== undefined && /[A-Za-z_$]/.test(character)) {
      let end = index + 1
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end] ?? '')) end += 1
      const identifier = source.slice(index, end)
      if (forbiddenCandidateDefinitionIdentifiers.has(identifier)) issues.push(identifier)
      index = end
      continue
    }
    index += 1
  }
  return [...new Set(issues)].sort()
}

const candidateDefinitionContext = (): vm.Context => {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
    name: 'bayn-qualification-candidate-definition',
  })
  vm.runInContext(
    `
      Object.defineProperty(globalThis, 'constructor', {
        value: null,
        writable: false,
        configurable: false,
      })
      Object.defineProperty(Error, 'prepareStackTrace', {
        value: undefined,
        writable: false,
        configurable: false,
      })
      Object.defineProperty(Error, 'captureStackTrace', {
        value: undefined,
        writable: false,
        configurable: false,
      })
      Error.stackTraceLimit = 0
      for (const name of [
        'process',
        'Bun',
        'console',
        'Date',
        'Intl',
        'Loader',
        'Temporal',
        'performance',
        'crypto',
        'navigator',
        'fetch',
        'require',
        'module',
        'exports',
        'Promise',
        'ShadowRealm',
        'Atomics',
        'SharedArrayBuffer',
        'FinalizationRegistry',
        'WeakRef',
        'WebAssembly',
        'Worker',
        'SharedWorker',
        'XMLHttpRequest',
        'WebSocket',
        'EventSource',
        'setTimeout',
        'setInterval',
        'setImmediate',
        'queueMicrotask',
      ]) {
        Object.defineProperty(globalThis, name, {
          value: undefined,
          writable: false,
          configurable: false,
        })
      }
      Object.defineProperty(Math, 'random', {
        value: undefined,
        writable: false,
        configurable: false,
      })
      for (const [prototype, names] of [
        [String.prototype, ['localeCompare', 'toLocaleLowerCase', 'toLocaleUpperCase']],
        [Number.prototype, ['toLocaleString']],
        [BigInt.prototype, ['toLocaleString']],
      ]) {
        for (const name of names) {
          Object.defineProperty(prototype, name, {
            value: undefined,
            writable: false,
            configurable: false,
          })
        }
      }
    `,
    context,
    { timeout: candidateDefinitionTimeoutMs },
  )
  return context
}

export interface QualificationCandidateImmutableSourceInput {
  readonly repositoryPath: string
  readonly sourceRevision: string
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly preregistrationBytes: Uint8Array
  readonly moduleBlobOid: string
  readonly moduleBytes: Uint8Array
}

export interface QualificationCandidateImmutableSourceReceipt {
  readonly schemaVersion: 'bayn.qualification-candidate-source.v1'
  readonly moduleBlobOid: string
  readonly compiledBoundedContentHash: string
  readonly definitionHash: string
}

const loadCandidateCompiledDefinition = (
  input: QualificationCandidateImmutableSourceInput,
): Effect.Effect<
  { readonly compiledBoundedContentHash: string; readonly definitionHash: string },
  QualificationCollectorError
> =>
  Effect.tryPromise({
    try: async (signal) => {
      if (signal.aborted) throw signal.reason
      const source = Buffer.from(input.moduleBytes).toString('utf8')
      const transpiler = new Bun.Transpiler({ loader: 'js' })
      const imports = transpiler.scanImports(source)
      const normalized = transpiler.transformSync(source)
      const identifiers = candidateDefinitionIdentifierIssues(normalized)
      if (imports.length > 0 || identifiers.length > 0) {
        throw new TypeError(
          `candidate module is not self-contained: imports=${JSON.stringify(imports)} identifiers=${JSON.stringify(identifiers)}`,
        )
      }
      const context = candidateDefinitionContext()
      const artifactModule = new vm.SourceTextModule(source, {
        context,
        identifier: `git:${input.sourceRevision}:${input.moduleBlobOid}`,
        initializeImportMeta: (meta) => Object.freeze(meta),
      })
      await artifactModule.link(() => {
        throw new TypeError('candidate artifact imports are prohibited')
      })
      await artifactModule.evaluate({ timeout: candidateDefinitionTimeoutMs })
      if (signal.aborted) throw signal.reason
      const artifact = Reflect.get(artifactModule.namespace, 'candidateDevelopmentArtifact') as unknown
      Object.defineProperty(context, '__candidateDevelopmentArtifact', {
        value: artifact,
        writable: false,
        configurable: false,
      })
      const encoded = vm.runInContext(
        `
          (() => {
            const artifact = globalThis.__candidateDevelopmentArtifact
            if (artifact === null || typeof artifact !== 'object') {
              throw new TypeError('candidateDevelopmentArtifact export is missing')
            }
            if (typeof artifact.buildEvaluation !== 'function') {
              throw new TypeError('candidateDevelopmentArtifact.buildEvaluation is missing')
            }
            return JSON.stringify({
              schemaVersion: artifact.schemaVersion,
              input: artifact.input,
              strategyProtocol: artifact.strategyProtocol,
            })
          })()
        `,
        context,
        { timeout: candidateDefinitionTimeoutMs },
      )
      if (typeof encoded !== 'string') throw new TypeError('candidate artifact definition is not JSON serializable')
      const definition = JSON.parse(encoded) as unknown
      const definitionRecord = recordOf(definition)
      const candidateInput = recordOf(definitionRecord?.input)
      const strategyProtocol = recordOf(definitionRecord?.strategyProtocol)
      const marketData = recordOf(strategyProtocol?.marketData)
      if (
        definitionRecord?.schemaVersion !== candidateArtifactSchemaVersion ||
        candidateInput?.candidateOrdinal !== input.preregistration.candidateOrdinal ||
        candidateInput?.priorTrialCount !== input.preregistration.priorTrialCount ||
        candidateInput?.expectedStrategyProtocolHash !== input.preregistration.strategyProtocolHash ||
        strategyProtocol?.schemaVersion !== candidateStrategyProtocolSchemaVersion ||
        marketData?.schemaVersion !== candidateMarketDataContractSchemaVersion ||
        marketData.snapshotId !== input.preregistration.marketData.snapshotId ||
        typeof marketData.contentHash !== 'string' ||
        !sha64.test(marketData.contentHash)
      ) {
        throw new TypeError('candidate artifact definition differs from the reviewed preregistration')
      }
      const strategyProtocolHash = Result.getOrThrow(canonicalHashV1Result(strategyProtocol))
      if (strategyProtocolHash !== input.preregistration.strategyProtocolHash) {
        throw new TypeError('candidate artifact strategy protocol hash differs from the reviewed preregistration')
      }
      const definitionHash = Result.getOrThrow(canonicalHashV1Result(definition))
      return { compiledBoundedContentHash: marketData.contentHash, definitionHash }
    },
    catch: (cause) =>
      collectorError(
        'candidate',
        'candidate-definition-invalid',
        'candidate module definition could not be verified',
        cause,
      ),
  })

export const verifyQualificationCandidateImmutableSource = (
  input: QualificationCandidateImmutableSourceInput,
): Effect.Effect<QualificationCandidateImmutableSourceReceipt, QualificationCollectorError> =>
  Effect.gen(function* () {
    const preregistrationDocument = yield* Effect.try({
      try: () => JSON.parse(Buffer.from(input.preregistrationBytes).toString('utf8')) as unknown,
      catch: (cause) =>
        collectorError(
          'candidate',
          'preregistration-document-malformed',
          'reviewed preregistration document is not valid JSON',
          cause,
        ),
    })
    yield* Effect.fromResult(
      validateCandidateDevelopmentPreregistrationDocument(input.preregistration, preregistrationDocument),
    ).pipe(
      Effect.mapError((cause) =>
        collectorError(
          'candidate',
          'preregistration-document-invalid',
          'reviewed preregistration document differs from the compiled calendar/module/data binding',
          cause,
        ),
      ),
    )
    yield* verifyCandidateDevelopmentPreregistrationModuleNovelty(
      input.repositoryPath,
      input.preregistration.preregistration.sourceRevision,
      input.preregistration.modulePath,
      input.moduleBlobOid,
    ).pipe(
      Effect.mapError((cause) =>
        collectorError(
          'candidate',
          'candidate-module-not-novel',
          'candidate module blob existed at or before preregistration',
          cause,
        ),
      ),
    )
    const definition = yield* loadCandidateCompiledDefinition(input)
    return {
      schemaVersion: 'bayn.qualification-candidate-source.v1',
      moduleBlobOid: input.moduleBlobOid,
      ...definition,
    }
  })

export interface QualificationCollectorPrelockEvidence {
  readonly schemaVersion: 'bayn.qualification-collector-prelock.v1'
  readonly repository: string
  readonly currentMainSha: string
  readonly sourceSha: string
  readonly imageRepository: string
  readonly imageDigest: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly preregistrationHash: string
  readonly moduleBlobOid: string
  readonly candidateDefinitionHash: string
  readonly compiledBoundedContentHash: string
  readonly activeAttemptRunIds: readonly string[]
  readonly githubRunId: string
  readonly githubRunAttempt: number
}

export interface QualificationCollectorExecutionReceipt {
  readonly schemaVersion: 'bayn.qualification-execution.v1'
  readonly runId: string
  readonly lockId: string
  readonly resultHash: string
  readonly verdict: 'QUALIFIED' | 'REJECTED'
  readonly persistence: {
    readonly artifactCount: number
    readonly eventCount: number
    readonly gateCount: number
  }
}

export interface QualificationCollectorTerminalEvidence {
  readonly schemaVersion: 'bayn.qualification-collector-terminal.v1'
  readonly repository: string
  readonly currentMainSha: string
  readonly sourceSha: string
  readonly image: { readonly repository: string; readonly digest: string }
  readonly candidateOrdinal: number
  readonly githubRunId: string
  readonly githubRunAttempt: number
  readonly preregistrationHash: string
  readonly eligibilityHash: string
  readonly candidateBindingHash: string
  readonly terminal: QualificationCollectorExecutionReceipt
  readonly audit: QualificationAuditReport
  readonly evidenceHash: string
}

export interface QualificationCollectorOperations<Prelock extends QualificationCollectorPrelockEvidence, R = never> {
  readonly collectPrelock: Effect.Effect<Prelock, QualificationCollectorError, R>
  readonly verifyCandidate: (
    prelock: Prelock,
  ) => Effect.Effect<QualificationCandidateBindingReceipt, QualificationCollectorError, R>
  readonly executeQualification: (
    prelock: Prelock,
    candidate: QualificationCandidateBindingReceipt,
  ) => Effect.Effect<QualificationCollectorExecutionReceipt, QualificationCollectorError, R>
  readonly auditQualification: (
    execution: QualificationCollectorExecutionReceipt,
  ) => Effect.Effect<QualificationAuditReport, QualificationCollectorError, R>
}

export const runQualificationCollector = <Prelock extends QualificationCollectorPrelockEvidence, R>(
  operations: QualificationCollectorOperations<Prelock, R>,
): Effect.Effect<QualificationCollectorTerminalEvidence, QualificationCollectorError, R> =>
  Effect.gen(function* () {
    const prelock = yield* operations.collectPrelock
    if (prelock.activeAttemptRunIds.length > 0) {
      return yield* collectorError(
        'eligibility',
        'qualification-attempt-in-flight',
        'another qualification workflow run is queued or in progress',
      )
    }
    const candidate = yield* operations.verifyCandidate(prelock)
    if (
      candidate.candidateOrdinal !== prelock.candidateOrdinal ||
      candidate.priorTrialCount !== prelock.priorTrialCount ||
      candidate.sourceRevision !== prelock.sourceSha ||
      candidate.imageRepository !== prelock.imageRepository ||
      candidate.imageDigest !== prelock.imageDigest ||
      candidate.compiledBoundedContentHash !== prelock.compiledBoundedContentHash
    ) {
      return yield* collectorError(
        'candidate',
        'candidate-binding-mismatch',
        'candidate binding differs from the immutable collector prelock evidence',
      )
    }

    const eligibilityMaterial = {
      repository: prelock.repository,
      currentMainSha: prelock.currentMainSha,
      sourceSha: prelock.sourceSha,
      imageRepository: prelock.imageRepository,
      imageDigest: prelock.imageDigest,
      strategyBehaviorHash: prelock.strategyBehaviorHash,
      strategyParameterHash: prelock.strategyParameterHash,
      candidateOrdinal: prelock.candidateOrdinal,
      priorTrialCount: prelock.priorTrialCount,
      preregistrationHash: prelock.preregistrationHash,
      moduleBlobOid: prelock.moduleBlobOid,
      candidateDefinitionHash: prelock.candidateDefinitionHash,
      compiledBoundedContentHash: prelock.compiledBoundedContentHash,
      candidateBindingHash: candidate.bindingHash,
      candidateRunId: candidate.candidateRunId,
      lockId: candidate.lockId,
      githubRunId: prelock.githubRunId,
      githubRunAttempt: prelock.githubRunAttempt,
    }
    const eligibilityHash = yield* Effect.fromResult(canonicalHashV1Result(eligibilityMaterial)).pipe(
      Effect.mapError((cause) =>
        collectorError('eligibility', 'eligibility-hash-failed', 'eligibility evidence could not be hashed', cause),
      ),
    )

    const execution = yield* operations.executeQualification(prelock, candidate)
    if (execution.runId !== candidate.candidateRunId || execution.lockId !== candidate.lockId) {
      return yield* collectorError(
        'execution',
        'terminal-binding-mismatch',
        'terminal qualification differs from the precommitted candidate lock',
      )
    }
    const audit = yield* operations.auditQualification(execution)
    if (
      audit.status !== 'PASS' ||
      audit.runId !== execution.runId ||
      audit.evidence.lockId !== execution.lockId ||
      audit.evidence.resultHash !== execution.resultHash
    ) {
      return yield* collectorError(
        'audit',
        'terminal-audit-mismatch',
        'independent audit did not reproduce the exact terminal qualification',
      )
    }

    const material = {
      schemaVersion: 'bayn.qualification-collector-terminal.v1' as const,
      repository: prelock.repository,
      currentMainSha: prelock.currentMainSha,
      sourceSha: prelock.sourceSha,
      image: { repository: prelock.imageRepository, digest: prelock.imageDigest },
      candidateOrdinal: prelock.candidateOrdinal,
      githubRunId: prelock.githubRunId,
      githubRunAttempt: prelock.githubRunAttempt,
      preregistrationHash: prelock.preregistrationHash,
      eligibilityHash,
      candidateBindingHash: candidate.bindingHash,
      terminal: execution,
      audit,
    }
    const evidenceHash = yield* Effect.fromResult(canonicalHashV1Result(material)).pipe(
      Effect.mapError((cause) =>
        collectorError('audit', 'terminal-evidence-hash-failed', 'terminal evidence could not be hashed', cause),
      ),
    )
    return { ...material, evidenceHash }
  })

interface DeploymentRuntime {
  readonly sourceSha: string
  readonly imageRepository: string
  readonly imageDigest: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly maximumAuthority: string
  readonly clickhouseUrl: string
  readonly signalSnapshotId: string
  readonly signalPublicationAsOf: string
  readonly signalCalendarVersion: string
  readonly signalDataStart: string
  readonly signalDataEnd: string
  readonly signalLookbackStart: string
  readonly signalEvaluationStart: string
  readonly signalEvaluationEnd: string
  readonly tigerBeetleClusterId: string
  readonly tigerBeetleAddresses: string
  readonly tigerBeetleLedger: string
}

interface StaticQualificationEvidence {
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly preregistrationHash: string
  readonly repositoryPath: string
  readonly repository: string
  readonly currentMainSha: string
  readonly sourceSha: string
  readonly githubRunId: string
  readonly githubRunAttempt: number
  readonly moduleBlobOid: string
  readonly candidateDefinitionHash: string
  readonly compiledBoundedContentHash: string
  readonly deployment: DeploymentRuntime
}

export interface QualificationCollectorInvocation {
  readonly mode: 'execute' | 'preflight'
  readonly eventName: 'schedule'
  readonly currentMainSha: string
}

interface QualificationWiring {
  readonly githubToken: string
  readonly clickhouseUsername: string
  readonly clickhousePassword: string
  readonly postgresUrl: string
  readonly postgresCaPem: string
  readonly signalPublisherUsername: string
  readonly auditClickhouseUsername: string
  readonly auditClickhousePassword: string
}

interface ProductionPrelockEvidence extends QualificationCollectorPrelockEvidence {
  readonly plan: ApplicationPlanFor<'BrokerlessService'>
  readonly inspection: MarketDataInspection
  readonly priorTrialRunIds: readonly string[]
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly dependencies: {
    readonly marketData: MarketDataService
    readonly journal: JournalService
    readonly evidenceStore: EvidenceStoreService
  }
}

export type QualificationAttemptState = 'FRESH' | 'RECOVER_TERMINAL'

export const qualificationAttemptState = (
  existing: Option.Option<QualificationRecord>,
): Effect.Effect<QualificationAttemptState, QualificationCollectorError> => {
  if (Option.isNone(existing)) return Effect.succeed('FRESH')
  if (existing.value.state === 'OPENED_INCOMPLETE') {
    return Effect.fail(
      collectorError(
        'execution',
        'qualification-opened-incomplete',
        'the exact candidate has an incomplete durable qualification lock and cannot be retried automatically',
      ),
    )
  }
  return Effect.succeed('RECOVER_TERMINAL')
}

export interface QualificationExecutionInput {
  readonly plan: ApplicationPlanFor<'BrokerlessService'>
  readonly inspection: MarketDataInspection
  readonly priorTrialRunIds: readonly string[]
  readonly dependencies: ProductionPrelockEvidence['dependencies']
}

export const executeQualificationAttempt = (
  input: QualificationExecutionInput,
  candidate: QualificationCandidateBindingReceipt,
): Effect.Effect<QualificationCollectorExecutionReceipt, QualificationCollectorError> =>
  Effect.gen(function* () {
    const existing = yield* input.dependencies.evidenceStore
      .readQualification(candidate.candidateRunId)
      .pipe(
        Effect.mapError((cause) =>
          collectorError(
            'execution',
            'qualification-state-read-failed',
            'qualification state could not be read',
            cause,
          ),
        ),
      )
    const attemptState = yield* qualificationAttemptState(existing)

    const state = yield* Ref.make(initialState())
    const executionDependencies = freezeQualificationPrelockDependencies(
      input.dependencies,
      input.inspection,
      input.priorTrialRunIds,
    )
    yield* runStartup(input.plan.config, state, input.plan.strategy, executionDependencies).pipe(
      Effect.mapError((cause) =>
        collectorError('execution', 'qualification-runtime-failed', 'qualification runtime failed', cause),
      ),
    )
    const completed = yield* Ref.get(state)
    if (completed.status === 'FAILED' || completed.evidence === null) {
      return yield* collectorError(
        'execution',
        'qualification-terminal-missing',
        completed.error ?? 'qualification did not produce terminal durable evidence',
      )
    }
    if (
      completed.evidence.startupMode === 'pinned' ||
      (attemptState === 'RECOVER_TERMINAL' && completed.evidence.startupMode !== 'recovered')
    ) {
      return yield* collectorError(
        'execution',
        'qualification-replay-invalid',
        'collector did not evaluate or recover the exact unpinned qualification attempt',
      )
    }
    const qualification = completed.evidence.qualification
    return {
      schemaVersion: 'bayn.qualification-execution.v1',
      runId: completed.evidence.evaluation.runId,
      lockId: qualification.lockId,
      resultHash: qualification.resultHash,
      verdict: qualification.verdict,
      persistence: {
        artifactCount: completed.evidence.persistence.artifactCount,
        eventCount: completed.evidence.persistence.eventCount,
        gateCount: completed.evidence.persistence.gateCount,
      },
    }
  })

export const freezeQualificationPrelockDependencies = (
  dependencies: ProductionPrelockEvidence['dependencies'],
  inspection: MarketDataInspection,
  priorTrialRunIds: readonly string[],
): ProductionPrelockEvidence['dependencies'] => ({
  marketData: { ...dependencies.marketData, inspect: Effect.succeed(inspection) },
  journal: dependencies.journal,
  evidenceStore: { ...dependencies.evidenceStore, listPriorTrials: Effect.succeed(priorTrialRunIds) },
})

export const requiredQualificationEnvironment = (
  environment: NodeJS.ProcessEnv,
  name: string,
): Effect.Effect<string, QualificationCollectorError> => {
  const value = environment[name]?.trim()
  return value === undefined || value.length === 0
    ? Effect.fail(collectorError('configuration', 'environment-missing', `${name} is required`))
    : Effect.succeed(value)
}

const positiveIntegerQualificationEnvironment = (
  environment: NodeJS.ProcessEnv,
  name: string,
): Effect.Effect<number, QualificationCollectorError> =>
  requiredQualificationEnvironment(environment, name).pipe(
    Effect.flatMap((raw) => {
      const value = Number(raw)
      return Number.isSafeInteger(value) && value >= 1
        ? Effect.succeed(value)
        : Effect.fail(collectorError('configuration', 'environment-invalid', `${name} must be a positive integer`))
    }),
  )

const canonicalRepository = (value: string): Effect.Effect<string, QualificationCollectorError> => {
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*)\/([A-Za-z0-9_.-]+)$/.exec(value.trim())
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return Effect.fail(
      collectorError('repository', 'repository-identity-invalid', 'repository must be an owner/name identity'),
    )
  }
  return Effect.succeed(`${match[1].toLowerCase()}/${match[2].toLowerCase()}`)
}

const repositoryFromOrigin = (value: string): Effect.Effect<string, QualificationCollectorError> => {
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      value.trim(),
    )
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return Effect.fail(
      collectorError('repository', 'origin-invalid', 'origin must be an explicit GitHub repository URL'),
    )
  }
  return canonicalRepository(`${match[1]}/${match[2]}`)
}

const gitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))

const gitOutput = (
  repositoryPath: string,
  args: readonly string[],
  signal: AbortSignal,
  encoding: 'buffer' | 'utf8' = 'utf8',
): Promise<Buffer | string> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryPath, ...args],
      { encoding, env: gitEnvironment(), maxBuffer: maximumGitOutputBytes, signal },
      (error, stdout) => {
        if (error !== null) rejectGit(error)
        else resolveGit(encoding === 'utf8' ? String(stdout).trim() : (stdout as Buffer))
      },
    )
  })

const gitText = (repositoryPath: string, args: readonly string[], signal: AbortSignal): Promise<string> =>
  gitOutput(repositoryPath, args, signal, 'utf8').then(String)

const gitBytes = (repositoryPath: string, args: readonly string[], signal: AbortSignal): Promise<Buffer> =>
  gitOutput(repositoryPath, args, signal, 'buffer').then((value) => value as Buffer)

const environmentValue = (deployment: string, name: string): string => {
  const pattern = new RegExp(`^\\s*- name: ${name}\\n\\s+value: ([^\\n]+)$`, 'gm')
  const matches = [...deployment.matchAll(pattern)]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw collectorError('configuration', 'deployment-binding-missing', `expected exactly one ${name} value`)
  }
  const value = matches[0][1].trim()
  return value.startsWith('"') ? String(JSON.parse(value)) : value
}

const hasEnvironmentBlock = (deployment: string, name: string): boolean =>
  new RegExp(`^\\s*- name: ${name}$`, 'm').test(deployment)

const exactBaynBuildInputPaths = new Set([
  'packages/scripts/src/bayn/update-manifests.ts',
  'packages/scripts/src/bayn/verify-release-review.ts',
  'nix/images/bayn.nix',
  'nix/images/bayn-runtime-root.nix',
  'nix/images/bun-workspace-service.nix',
  'nix/images/bun-workspace-deps-source.nix',
  'nix/packages.nix',
  'nix/cache-push.sh',
  'nix/ci-nix-oci-summary.sh',
  'nix/ci-run-timed.sh',
  'nix/oci-inspect-archive.sh',
  'nix/oci-push.sh',
  'nix/oci-release-contract.sh',
  'nix/verify-bayn-image-command.sh',
  'flake.nix',
  'flake.lock',
  'package.json',
  'bun.lock',
  '.npmrc',
  'bunfig.toml',
  'tsconfig.base.json',
])

export const isQualificationSourceAffectingPath = (path: string): boolean =>
  path.startsWith('services/bayn/') ||
  path.startsWith('patches/') ||
  path.startsWith('.github/actions/setup-nix-toolchain/') ||
  /^\.github\/workflows\/bayn-[^/]+\.yml$/.test(path) ||
  path.endsWith('/package.json') ||
  exactBaynBuildInputPaths.has(path) ||
  path === '.github/workflows/nix-oci-build-common.yml'

const loadDeploymentRuntime = async (repositoryPath: string): Promise<DeploymentRuntime> => {
  const path = resolve(repositoryPath, 'argocd/applications/bayn/deployment.yaml')
  const deployment = await readFile(path, 'utf8')
  if (hasEnvironmentBlock(deployment, 'BAYN_QUALIFICATION_RUN_ID')) {
    throw collectorError(
      'eligibility',
      'qualification-pin-present',
      'a fresh qualification attempt requires the exact promoted runtime to be unpinned',
    )
  }
  const runtime: DeploymentRuntime = {
    sourceSha: environmentValue(deployment, 'BAYN_CODE_REVISION'),
    imageRepository: environmentValue(deployment, 'BAYN_IMAGE_REPOSITORY'),
    imageDigest: environmentValue(deployment, 'BAYN_IMAGE_DIGEST'),
    strategyBehaviorHash: environmentValue(deployment, 'BAYN_STRATEGY_BEHAVIOR_HASH'),
    strategyParameterHash: environmentValue(deployment, 'BAYN_STRATEGY_PARAMETER_HASH'),
    maximumAuthority: environmentValue(deployment, 'BAYN_MAXIMUM_AUTHORITY'),
    clickhouseUrl: environmentValue(deployment, 'BAYN_CLICKHOUSE_URL'),
    signalSnapshotId: environmentValue(deployment, 'BAYN_SIGNAL_SNAPSHOT_ID'),
    signalPublicationAsOf: environmentValue(deployment, 'BAYN_SIGNAL_PUBLICATION_ASOF'),
    signalCalendarVersion: environmentValue(deployment, 'BAYN_SIGNAL_CALENDAR_VERSION'),
    signalDataStart: environmentValue(deployment, 'BAYN_SIGNAL_DATA_START'),
    signalDataEnd: environmentValue(deployment, 'BAYN_SIGNAL_DATA_END'),
    signalLookbackStart: environmentValue(deployment, 'BAYN_SIGNAL_LOOKBACK_START'),
    signalEvaluationStart: environmentValue(deployment, 'BAYN_SIGNAL_EVALUATION_START'),
    signalEvaluationEnd: environmentValue(deployment, 'BAYN_SIGNAL_EVALUATION_END'),
    tigerBeetleClusterId: environmentValue(deployment, 'BAYN_TIGERBEETLE_CLUSTER_ID'),
    tigerBeetleAddresses: environmentValue(deployment, 'BAYN_TIGERBEETLE_ADDRESSES'),
    tigerBeetleLedger: environmentValue(deployment, 'BAYN_TIGERBEETLE_LEDGER'),
  }
  if (!sha40.test(runtime.sourceSha) || !imageDigest.test(runtime.imageDigest)) {
    throw collectorError('configuration', 'deployment-binding-invalid', 'deployment source or image digest is invalid')
  }
  if (!sha64.test(runtime.strategyBehaviorHash) || !sha64.test(runtime.strategyParameterHash)) {
    throw collectorError('configuration', 'deployment-binding-invalid', 'deployment strategy hashes are invalid')
  }
  if (runtime.maximumAuthority !== 'OBSERVE') {
    throw collectorError('configuration', 'authority-not-observe', 'qualification image must remain OBSERVE-only')
  }
  return runtime
}

export const loadQualificationCollectorInvocation = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<QualificationCollectorInvocation, QualificationCollectorError> =>
  Effect.gen(function* () {
    const eventName = yield* requiredQualificationEnvironment(environment, 'GITHUB_EVENT_NAME')
    if (eventName === 'workflow_dispatch') {
      return yield* collectorError(
        'eligibility',
        'manual-dispatch-rejected',
        'manual qualification dispatch is forbidden',
      )
    }
    if (eventName !== 'schedule') {
      return yield* collectorError('eligibility', 'event-not-trusted', `unexpected qualification event ${eventName}`)
    }
    const currentMainSha = yield* requiredQualificationEnvironment(environment, 'GITHUB_SHA')
    if (!sha40.test(currentMainSha)) {
      return yield* collectorError('repository', 'source-sha-invalid', 'scheduled source SHA is invalid')
    }
    const rawMode = environment.BAYN_QUALIFICATION_MODE?.trim() || 'execute'
    if (rawMode !== 'execute' && rawMode !== 'preflight') {
      return yield* collectorError(
        'configuration',
        'collector-mode-invalid',
        'BAYN_QUALIFICATION_MODE must be execute or preflight',
      )
    }
    return { mode: rawMode, eventName: 'schedule', currentMainSha }
  })

const collectStaticQualificationEvidence = (invocation: QualificationCollectorInvocation) =>
  Effect.gen(function* () {
    const preregistration = frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration
    if (preregistration === null) return Option.none<StaticQualificationEvidence>()

    const repositoryPathInput = yield* requiredQualificationEnvironment(
      process.env,
      'BAYN_QUALIFICATION_REPOSITORY_PATH',
    )
    const repositoryPath = yield* Effect.tryPromise({
      try: () => realpath(repositoryPathInput),
      catch: (cause) => collectorError('repository', 'repository-path-invalid', 'repository path is invalid', cause),
    })
    const repository = yield* requiredQualificationEnvironment(process.env, 'GITHUB_REPOSITORY').pipe(
      Effect.flatMap(canonicalRepository),
    )
    const trustedRepository = yield* requiredQualificationEnvironment(
      process.env,
      'BAYN_QUALIFICATION_TRUSTED_REPOSITORY',
    ).pipe(Effect.flatMap(canonicalRepository))
    if (repository !== trustedRepository) {
      return yield* collectorError('repository', 'repository-identity-mismatch', 'workflow repository is not trusted')
    }
    const currentMainSha = invocation.currentMainSha
    if (embeddedBuildMetadata === undefined) {
      return yield* collectorError(
        'configuration',
        'embedded-build-missing',
        'qualification collector requires production build metadata',
      )
    }

    yield* verifyCandidateDevelopmentRepositoryIntegrity(repositoryPath).pipe(
      Effect.mapError((cause) =>
        collectorError('repository', 'repository-integrity-invalid', 'repository integrity verification failed', cause),
      ),
    )

    const deployment = yield* Effect.tryPromise({
      try: () => loadDeploymentRuntime(repositoryPath),
      catch: (cause) =>
        cause instanceof QualificationCollectorError
          ? cause
          : collectorError('configuration', 'deployment-read-failed', 'deployment runtime could not be read', cause),
    })
    if (embeddedBuildMetadata.sourceRevision !== deployment.sourceSha) {
      return yield* collectorError(
        'configuration',
        'image-source-mismatch',
        'qualification image source differs from the promoted deployment source',
      )
    }
    if (deployment.sourceSha !== currentMainSha) {
      yield* verifyCandidateDevelopmentPreregistrationLineage(
        repositoryPath,
        deployment.sourceSha,
        currentMainSha,
      ).pipe(
        Effect.mapError((cause) =>
          collectorError(
            'repository',
            'image-source-lineage-invalid',
            'promoted image source is not an ancestor of current main',
            cause,
          ),
        ),
      )
    }
    yield* verifyCandidateDevelopmentPreregistrationLineage(
      repositoryPath,
      preregistration.preregistration.sourceRevision,
      deployment.sourceSha,
    ).pipe(
      Effect.mapError((cause) =>
        collectorError(
          'repository',
          'preregistration-lineage-invalid',
          'preregistration lineage verification failed',
          cause,
        ),
      ),
    )

    const staticGit = yield* Effect.tryPromise({
      try: async (signal) => {
        const [
          topLevel,
          head,
          originMain,
          originUrls,
          configuration,
          preregistrationBytes,
          preregistrationBlobOid,
          moduleBlobOid,
          moduleBytes,
          sourceAdvancePaths,
        ] = await Promise.all([
          gitText(repositoryPath, ['rev-parse', '--show-toplevel'], signal).then(realpath),
          gitText(repositoryPath, ['rev-parse', 'HEAD'], signal),
          gitText(repositoryPath, ['rev-parse', 'refs/remotes/origin/main'], signal),
          gitText(repositoryPath, ['config', '--get-all', 'remote.origin.url'], signal),
          gitText(repositoryPath, ['config', '--list'], signal),
          gitBytes(
            repositoryPath,
            [
              'cat-file',
              'blob',
              `${preregistration.preregistration.sourceRevision}:${preregistration.preregistration.path}`,
            ],
            signal,
          ),
          gitText(
            repositoryPath,
            ['rev-parse', `${preregistration.preregistration.sourceRevision}:${preregistration.preregistration.path}`],
            signal,
          ),
          gitText(repositoryPath, ['rev-parse', `${deployment.sourceSha}:${preregistration.modulePath}`], signal),
          gitBytes(
            repositoryPath,
            ['cat-file', 'blob', `${deployment.sourceSha}:${preregistration.modulePath}`],
            signal,
          ),
          deployment.sourceSha === currentMainSha
            ? Promise.resolve('')
            : gitText(
                repositoryPath,
                ['diff', '--no-renames', '--name-only', `${deployment.sourceSha}..${currentMainSha}`],
                signal,
              ),
        ])
        return {
          topLevel,
          head,
          originMain,
          originUrls,
          configuration,
          preregistrationBytes,
          preregistrationBlobOid,
          moduleBlobOid,
          moduleBytes,
          moduleSha256: createHash('sha256').update(moduleBytes).digest('hex'),
          sourceAdvancePaths: sourceAdvancePaths
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean),
        }
      },
      catch: (cause) =>
        collectorError('repository', 'git-read-failed', 'immutable Git evidence collection failed', cause),
    })
    const rawOriginUrls = staticGit.originUrls
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
    const rewriteKeys = staticGit.configuration
      .split('\n')
      .map((line) => line.slice(0, line.indexOf('=')).toLowerCase())
      .filter((key) => key.startsWith('url.') && (key.endsWith('.insteadof') || key.endsWith('.pushinsteadof')))
    const observedRepository =
      rawOriginUrls.length === 1 ? yield* repositoryFromOrigin(rawOriginUrls[0] ?? '') : undefined
    if (
      staticGit.topLevel !== repositoryPath ||
      staticGit.head !== currentMainSha ||
      staticGit.originMain !== currentMainSha ||
      rawOriginUrls.length !== 1 ||
      observedRepository !== trustedRepository ||
      rewriteKeys.length !== 0
    ) {
      return yield* collectorError(
        'repository',
        'repository-binding-invalid',
        'checked-out repository, origin, or exact main binding is invalid',
      )
    }

    if (
      staticGit.preregistrationBlobOid !== preregistration.preregistration.blobOid ||
      staticGit.moduleBlobOid.length !== 40 ||
      staticGit.moduleSha256 !== preregistration.moduleSha256
    ) {
      return yield* collectorError(
        'repository',
        'preregistration-source-mismatch',
        'preregistration document or candidate module differs from the reviewed immutable source',
      )
    }
    const candidateSource = yield* verifyQualificationCandidateImmutableSource({
      repositoryPath,
      sourceRevision: deployment.sourceSha,
      preregistration,
      preregistrationBytes: staticGit.preregistrationBytes,
      moduleBlobOid: staticGit.moduleBlobOid,
      moduleBytes: staticGit.moduleBytes,
    })

    yield* verifyCandidateDevelopmentRepositoryIntegrity(repositoryPath).pipe(
      Effect.mapError((cause) =>
        collectorError(
          'repository',
          'repository-integrity-invalid',
          'repository changed during evidence collection',
          cause,
        ),
      ),
    )
    const finalGit = yield* Effect.tryPromise({
      try: async (signal) => {
        const [head, originMain, originUrls, configuration] = await Promise.all([
          gitText(repositoryPath, ['rev-parse', 'HEAD'], signal),
          gitText(repositoryPath, ['rev-parse', 'refs/remotes/origin/main'], signal),
          gitText(repositoryPath, ['config', '--get-all', 'remote.origin.url'], signal),
          gitText(repositoryPath, ['config', '--list'], signal),
        ])
        return { head, originMain, originUrls, configuration }
      },
      catch: (cause) =>
        collectorError('repository', 'git-recheck-failed', 'repository bindings could not be rechecked', cause),
    })
    const finalOrigins = finalGit.originUrls
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
    const finalRewriteKeys = finalGit.configuration
      .split('\n')
      .map((line) => line.slice(0, line.indexOf('=')).toLowerCase())
      .filter((key) => key.startsWith('url.') && (key.endsWith('.insteadof') || key.endsWith('.pushinsteadof')))
    const finalRepository = finalOrigins.length === 1 ? yield* repositoryFromOrigin(finalOrigins[0] ?? '') : undefined
    if (
      finalGit.head !== currentMainSha ||
      finalGit.originMain !== currentMainSha ||
      finalOrigins.length !== 1 ||
      finalRepository !== trustedRepository ||
      finalRewriteKeys.length !== 0
    ) {
      return yield* collectorError(
        'repository',
        'repository-binding-changed',
        'repository identity or current main changed during evidence collection',
      )
    }
    const staleSourcePaths = staticGit.sourceAdvancePaths.filter(isQualificationSourceAffectingPath)
    if (staleSourcePaths.length > 0) {
      return yield* collectorError(
        'repository',
        'image-source-stale',
        `current main contains Bayn image input changes after the promoted source: ${staleSourcePaths.slice(0, 5).join(', ')}`,
      )
    }
    const imageReference = yield* requiredQualificationEnvironment(process.env, 'BAYN_QUALIFICATION_IMAGE_REFERENCE')
    if (
      deployment.imageRepository !== embeddedBuildMetadata.imageRepository ||
      deployment.strategyBehaviorHash !== embeddedBuildMetadata.strategyBehaviorHash ||
      deployment.strategyParameterHash !== embeddedBuildMetadata.strategyParameterHash ||
      imageReference !== `${deployment.imageRepository}@${deployment.imageDigest}`
    ) {
      return yield* collectorError(
        'configuration',
        'promoted-image-binding-invalid',
        'promoted deployment does not bind the exact collector image and scheduled main',
      )
    }
    const preregistrationHash = yield* Effect.fromResult(canonicalHashV1Result(preregistration)).pipe(
      Effect.mapError((cause) =>
        collectorError('eligibility', 'preregistration-hash-failed', 'preregistration could not be hashed', cause),
      ),
    )
    const githubRunId = yield* requiredQualificationEnvironment(process.env, 'GITHUB_RUN_ID')
    const githubRunAttempt = yield* positiveIntegerQualificationEnvironment(process.env, 'GITHUB_RUN_ATTEMPT')
    return Option.some<StaticQualificationEvidence>({
      preregistration,
      preregistrationHash,
      repositoryPath,
      repository,
      currentMainSha,
      sourceSha: deployment.sourceSha,
      githubRunId,
      githubRunAttempt,
      moduleBlobOid: candidateSource.moduleBlobOid,
      candidateDefinitionHash: candidateSource.definitionHash,
      compiledBoundedContentHash: candidateSource.compiledBoundedContentHash,
      deployment,
    })
  })

const requiredWiringNames = [
  'GITHUB_TOKEN',
  'BAYN_CLICKHOUSE_USERNAME',
  'BAYN_CLICKHOUSE_PASSWORD',
  'BAYN_POSTGRES_URL',
  'BAYN_QUALIFICATION_POSTGRES_CA_PEM',
  'BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME',
  'BAYN_AUDIT_CLICKHOUSE_USERNAME',
  'BAYN_AUDIT_CLICKHOUSE_PASSWORD',
] as const

export const missingQualificationWiring = (environment: NodeJS.ProcessEnv): readonly string[] =>
  requiredWiringNames.filter((name) => environment[name]?.trim().length === 0 || environment[name] === undefined)

const loadQualificationWiring = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<QualificationWiring, QualificationCollectorError> => {
  const missing = missingQualificationWiring(environment)
  if (missing.length > 0) {
    return Effect.fail(
      collectorError(
        'wiring',
        'qualification-wiring-missing',
        `qualification secret wiring is missing: ${missing.join(', ')}`,
      ),
    )
  }
  return Effect.succeed({
    githubToken: environment.GITHUB_TOKEN?.trim() ?? '',
    clickhouseUsername: environment.BAYN_CLICKHOUSE_USERNAME?.trim() ?? '',
    clickhousePassword: environment.BAYN_CLICKHOUSE_PASSWORD?.trim() ?? '',
    postgresUrl: environment.BAYN_POSTGRES_URL?.trim() ?? '',
    postgresCaPem: environment.BAYN_QUALIFICATION_POSTGRES_CA_PEM?.trim() ?? '',
    signalPublisherUsername: environment.BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME?.trim() ?? '',
    auditClickhouseUsername: environment.BAYN_AUDIT_CLICKHOUSE_USERNAME?.trim() ?? '',
    auditClickhousePassword: environment.BAYN_AUDIT_CLICKHOUSE_PASSWORD?.trim() ?? '',
  })
}

export interface QualificationWorkflowRunIdentity {
  readonly id: number
  readonly status: 'in_progress' | 'queued'
}

export const blockingQualificationWorkflowRunIds = (
  currentRunId: number,
  runs: readonly QualificationWorkflowRunIdentity[],
): readonly string[] => {
  if (!Number.isSafeInteger(currentRunId) || currentRunId < 1) {
    throw new TypeError('current GitHub Actions run ID is invalid')
  }
  const blocking = new Set<string>()
  for (const run of runs) {
    if (!Number.isSafeInteger(run.id) || run.id < 1) throw new TypeError('GitHub Actions run ID is invalid')
    if (run.id !== currentRunId && (run.status === 'in_progress' || run.id < currentRunId)) {
      blocking.add(String(run.id))
    }
  }
  return [...blocking].sort((left, right) => Number(left) - Number(right))
}

const configureRuntimeEnvironment = (
  staticEvidence: StaticQualificationEvidence,
  caPath: string,
  wiring: QualificationWiring,
): void => {
  const deployment = staticEvidence.deployment
  const operationTimeout =
    process.env.BAYN_QUALIFICATION_OPERATION_TIMEOUT_MS?.trim() || String(defaultOperationTimeoutMs)
  Object.assign(process.env, {
    NODE_ENV: 'production',
    BAYN_PROVENANCE_MODE: 'production',
    BAYN_CODE_REVISION: deployment.sourceSha,
    BAYN_IMAGE_REPOSITORY: deployment.imageRepository,
    BAYN_IMAGE_DIGEST: deployment.imageDigest,
    BAYN_STRATEGY_BEHAVIOR_HASH: deployment.strategyBehaviorHash,
    BAYN_STRATEGY_PARAMETER_HASH: deployment.strategyParameterHash,
    BAYN_MAXIMUM_AUTHORITY: deployment.maximumAuthority,
    BAYN_OPERATION_TIMEOUT_MS: operationTimeout,
    BAYN_CLICKHOUSE_URL: deployment.clickhouseUrl,
    BAYN_SIGNAL_SNAPSHOT_ID: deployment.signalSnapshotId,
    BAYN_SIGNAL_PUBLICATION_ASOF: deployment.signalPublicationAsOf,
    BAYN_SIGNAL_CALENDAR_VERSION: deployment.signalCalendarVersion,
    BAYN_SIGNAL_DATA_START: deployment.signalDataStart,
    BAYN_SIGNAL_DATA_END: deployment.signalDataEnd,
    BAYN_SIGNAL_LOOKBACK_START: deployment.signalLookbackStart,
    BAYN_SIGNAL_EVALUATION_START: deployment.signalEvaluationStart,
    BAYN_SIGNAL_EVALUATION_END: deployment.signalEvaluationEnd,
    BAYN_POSTGRES_TLS: 'true',
    BAYN_POSTGRES_CA_PATH: caPath,
    BAYN_TIGERBEETLE_CLUSTER_ID: deployment.tigerBeetleClusterId,
    BAYN_TIGERBEETLE_ADDRESSES: deployment.tigerBeetleAddresses,
    BAYN_TIGERBEETLE_LEDGER: deployment.tigerBeetleLedger,
    BAYN_AUDIT_OUTPUT: 'audit',
    BAYN_AUDIT_POSTGRES_URL: wiring.postgresUrl,
    BAYN_AUDIT_POSTGRES_TLS: 'true',
    BAYN_AUDIT_POSTGRES_CA_PATH: caPath,
    BAYN_AUDIT_SIGNAL_URL: deployment.clickhouseUrl,
    BAYN_AUDIT_SIGNAL_USERNAME: wiring.clickhouseUsername,
    BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME: wiring.signalPublisherUsername,
    BAYN_AUDIT_SIGNAL_PASSWORD: wiring.clickhousePassword,
    BAYN_AUDIT_CLICKHOUSE_URLS: process.env.BAYN_AUDIT_CLICKHOUSE_URLS?.trim() || defaultAuditReplicaUrls.join(','),
    BAYN_AUDIT_CLICKHOUSE_USERNAME: wiring.auditClickhouseUsername,
    BAYN_AUDIT_CLICKHOUSE_PASSWORD: wiring.auditClickhousePassword,
    BAYN_AUDIT_REPOSITORY_PATH: staticEvidence.repositoryPath,
    BAYN_AUDIT_OPERATION_TIMEOUT_MS: operationTimeout,
  })
  delete process.env.BAYN_QUALIFICATION_RUN_ID
}

const activeWorkflowRuns = (
  repository: string,
  currentRunId: string,
  githubToken: string,
): Effect.Effect<readonly string[], QualificationCollectorError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const currentRunNumber = Number(currentRunId)
      if (!Number.isSafeInteger(currentRunNumber) || currentRunNumber < 1) {
        throw new Error('current GitHub Actions run ID is invalid')
      }
      const api = (process.env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/$/, '')
      const runs: QualificationWorkflowRunIdentity[] = []
      for (const status of ['queued', 'in_progress'] as const) {
        const response = await fetch(
          `${api}/repos/${repository}/actions/workflows/bayn-qualification.yml/runs?status=${status}&per_page=100`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${githubToken}`,
              'X-GitHub-Api-Version': '2022-11-28',
            },
            signal,
          },
        )
        if (!response.ok) throw new Error(`GitHub Actions run query returned ${response.status}`)
        if (response.headers.get('link')?.includes('rel="next"') === true) {
          throw new Error('GitHub Actions run query exceeded one bounded page')
        }
        const body = (await response.json()) as {
          readonly total_count?: number
          readonly workflow_runs?: readonly { readonly id?: number; readonly head_sha?: string }[]
        }
        if (
          !Number.isSafeInteger(body.total_count) ||
          body.total_count === undefined ||
          body.total_count < 0 ||
          !Array.isArray(body.workflow_runs) ||
          body.total_count !== body.workflow_runs.length
        ) {
          throw new Error('GitHub Actions run query returned incomplete or malformed evidence')
        }
        for (const run of body.workflow_runs) {
          if (!Number.isSafeInteger(run.id) || run.id === undefined || run.id < 1 || !sha40.test(run.head_sha ?? '')) {
            throw new Error('GitHub Actions run query returned an invalid run identity')
          }
          runs.push({ id: run.id, status })
        }
      }
      return blockingQualificationWorkflowRunIds(currentRunNumber, runs)
    },
    catch: (cause) =>
      cause instanceof QualificationCollectorError
        ? cause
        : collectorError(
            'eligibility',
            'github-attempt-read-failed',
            'active workflow attempts could not be read',
            cause,
          ),
  })

const qualificationResources = (plan: ApplicationPlanFor<'BrokerlessService'>) => {
  const clickhouse = sqlResource(ClickHouseClientResourceLive(plan.config))
  const marketData = MarketDataResourceLive(plan).pipe(Layer.provide(clickhouse))
  const postgres = sqlResource(
    EvidenceStoreResourceLive(plan.config).pipe(Layer.provideMerge(PostgresClientResourceLive(plan.config))),
  )
  return Layer.mergeAll(marketData, postgres, JournalResourceLive(plan.config)).pipe(
    Layer.provideMerge(ApplicationPlatformLive),
  )
}

const makeProductionOperations = (
  staticEvidence: StaticQualificationEvidence,
  plan: ApplicationPlanFor<'BrokerlessService'>,
  githubToken: string,
): QualificationCollectorOperations<
  ProductionPrelockEvidence,
  MarketData | Journal | EvidenceStore | NodeServices.NodeServices | Reactivity.Reactivity
> => {
  let collected: ProductionPrelockEvidence | undefined
  return {
    collectPrelock: Effect.gen(function* () {
      const dependencies = yield* Effect.all({
        marketData: MarketData,
        journal: Journal,
        evidenceStore: EvidenceStore,
      })
      const [inspection, priorTrialRunIds, activeAttemptRunIds] = yield* Effect.all([
        dependencies.marketData.inspect.pipe(
          Effect.mapError((cause) =>
            collectorError(
              'eligibility',
              'publication-inspection-failed',
              'Signal publication inspection failed',
              cause,
            ),
          ),
        ),
        dependencies.evidenceStore.listPriorTrials.pipe(
          Effect.mapError((cause) =>
            collectorError(
              'eligibility',
              'trial-lineage-read-failed',
              'qualification trial lineage could not be read',
              cause,
            ),
          ),
        ),
        activeWorkflowRuns(staticEvidence.repository, staticEvidence.githubRunId, githubToken),
      ])
      const value: ProductionPrelockEvidence = {
        schemaVersion: 'bayn.qualification-collector-prelock.v1',
        repository: staticEvidence.repository,
        currentMainSha: staticEvidence.currentMainSha,
        sourceSha: staticEvidence.sourceSha,
        imageRepository: staticEvidence.deployment.imageRepository,
        imageDigest: staticEvidence.deployment.imageDigest,
        strategyBehaviorHash: staticEvidence.deployment.strategyBehaviorHash,
        strategyParameterHash: staticEvidence.deployment.strategyParameterHash,
        candidateOrdinal: staticEvidence.preregistration.candidateOrdinal,
        priorTrialCount: staticEvidence.preregistration.priorTrialCount,
        preregistrationHash: staticEvidence.preregistrationHash,
        moduleBlobOid: staticEvidence.moduleBlobOid,
        candidateDefinitionHash: staticEvidence.candidateDefinitionHash,
        compiledBoundedContentHash: staticEvidence.compiledBoundedContentHash,
        activeAttemptRunIds,
        githubRunId: staticEvidence.githubRunId,
        githubRunAttempt: staticEvidence.githubRunAttempt,
        plan,
        inspection,
        priorTrialRunIds,
        preregistration: staticEvidence.preregistration,
        dependencies,
      }
      collected = value
      return value
    }),
    verifyCandidate: (prelock) =>
      Effect.fromResult(
        verifyQualificationCandidateBinding(
          prelock.preregistration,
          prelock.compiledBoundedContentHash,
          prelock.plan,
          prelock.inspection,
          prelock.priorTrialRunIds,
        ),
      ).pipe(
        Effect.mapError((cause) =>
          collectorError('candidate', 'candidate-binding-invalid', 'candidate metadata binding failed', cause),
        ),
      ),
    executeQualification: (prelock, candidate) =>
      Effect.gen(function* () {
        if (collected !== prelock) {
          return yield* collectorError(
            'execution',
            'prelock-evidence-replaced',
            'qualification execution must consume the exact collected prelock evidence',
          )
        }
        return yield* executeQualificationAttempt(
          {
            plan: prelock.plan,
            inspection: prelock.inspection,
            priorTrialRunIds: prelock.priorTrialRunIds,
            dependencies: prelock.dependencies,
          },
          candidate,
        )
      }),
    auditQualification: (execution) =>
      Effect.sync(() => {
        process.env.BAYN_AUDIT_RUN_ID = execution.runId
      }).pipe(
        Effect.andThen(collectQualificationAuditReport),
        Effect.mapError((cause) =>
          collectorError('audit', 'qualification-audit-failed', 'independent qualification audit failed', cause),
        ),
      ),
  }
}

const privateCaFile = (pem: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const directory = await mkdtemp(join(tmpdir(), 'bayn-qualification-'))
        const path = join(directory, 'postgres-ca.crt')
        await writeFile(path, pem, { encoding: 'utf8', mode: 0o600 })
        return { directory, path }
      },
      catch: (cause) =>
        collectorError('wiring', 'postgres-ca-write-failed', 'PostgreSQL CA could not be staged', cause),
    }),
    ({ directory }) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )

export const qualificationCollectorProgram = Effect.gen(function* () {
  const invocation = yield* loadQualificationCollectorInvocation(process.env)
  const staticEvidence = yield* collectStaticQualificationEvidence(invocation)
  if (Option.isNone(staticEvidence)) {
    return {
      schemaVersion: 'bayn.qualification-collector-dormant.v1' as const,
      status: 'DORMANT' as const,
      reason: 'preregistration-missing' as const,
    }
  }
  if (invocation.mode === 'preflight') {
    return {
      schemaVersion: 'bayn.qualification-collector-preflight.v1' as const,
      status: 'READY' as const,
      repository: staticEvidence.value.repository,
      currentMainSha: staticEvidence.value.currentMainSha,
      sourceSha: staticEvidence.value.sourceSha,
      image: {
        repository: staticEvidence.value.deployment.imageRepository,
        digest: staticEvidence.value.deployment.imageDigest,
      },
      candidateOrdinal: staticEvidence.value.preregistration.candidateOrdinal,
      preregistrationHash: staticEvidence.value.preregistrationHash,
    }
  }
  const wiring = yield* loadQualificationWiring(process.env)
  const ca = yield* privateCaFile(wiring.postgresCaPem)
  configureRuntimeEnvironment(staticEvidence.value, ca.path, wiring)
  const plan = yield* loadApplicationPlan.pipe(
    Effect.mapError((cause) =>
      collectorError('configuration', 'application-plan-invalid', 'qualification runtime plan is invalid', cause),
    ),
  )
  if (plan._tag !== 'BrokerlessService' || plan.config.qualificationRunId !== undefined) {
    return yield* collectorError(
      'configuration',
      'qualification-runtime-mode-invalid',
      'qualification collector requires an unpinned brokerless production runtime',
    )
  }
  return yield* runQualificationCollector(
    makeProductionOperations(staticEvidence.value, plan, wiring.githubToken),
  ).pipe(
    Effect.provide(qualificationResources(plan)),
    Effect.mapError((cause) =>
      cause instanceof QualificationCollectorError
        ? cause
        : collectorError('configuration', 'qualification-resource-failed', 'qualification resources failed', cause),
    ),
  )
}).pipe(Effect.scoped)

const runtime = Layer.mergeAll(
  Logger.layer([Logger.consoleJson]),
  NodeServices.layer,
  NodeHttpClient.layerNodeHttp,
  Reactivity.layer,
)

export const qualificationCollectorMain = qualificationCollectorProgram.pipe(
  Effect.tap((output) =>
    Effect.sync(() => process.stdout.write(`BAYN_QUALIFICATION_TERMINAL=${JSON.stringify(output)}\n`)),
  ),
  Effect.tapError((error) =>
    Effect.sync(() =>
      process.stderr.write(`qualification collector failed [${error.phase}/${error.code}]: ${error.message}\n`),
    ),
  ),
  Effect.provide(runtime),
)

if (import.meta.main) NodeRuntime.runMain(qualificationCollectorMain)
