import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, Layer, Logger, Option, Result, Schema } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import type { ApplicationPlanFor } from './app'
import { embeddedBuildMetadata } from './build'
import {
  activeCandidateDevelopmentRegistration,
  candidateDevelopmentTrialLedgerState,
  type CandidateDevelopmentNextPreregistration,
} from './candidate-development-calendar'
import { qualificationDormancyDecisionFromLedgerState } from './candidate-development-trials/qualification-dormancy'
import { makeRuntimeProvenanceResult, makeStrategyProtocolHash } from './contracts'
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
  type QualificationCandidateRuntime,
} from './qualification-binding'
import type { QualificationAuditReport } from './audit/audit'
import { hashParameters } from './protocol'
import { decideQualificationPath, evaluateLockedSnapshot, qualifyEvaluation } from './startup/decisions'
import {
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from './schemas'
import type { QualificationCandidateApplication } from './qualification-binding'

const sha40 = /^[0-9a-f]{40}$/
const sha64 = /^[0-9a-f]{64}$/
const imageDigest = /^sha256:[0-9a-f]{64}$/
const maximumGitOutputBytes = 16 * 1024 * 1024
const defaultOperationTimeoutMs = 60_000
const defaultAuditReplicaUrls = [
  'http://chi-torghut-clickhouse-default-0-0.torghut.svc.cluster.local:8123',
  'http://chi-torghut-clickhouse-default-0-1.torghut.svc.cluster.local:8123',
] as const

const CandidateDevelopmentNextPreregistrationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-next-preregistration.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  strategyProtocolHash: Sha256Schema,
  strategyIdentityHash: Schema.optionalKey(Sha256Schema),
  candidateDevelopmentProtocolHash: Schema.optionalKey(Sha256Schema),
  calendarHash: Schema.optionalKey(Sha256Schema),
  priorTrialsHash: Schema.optionalKey(Sha256Schema),
  modulePath: StrictNonEmptyStringSchema,
  moduleSha256: Sha256Schema,
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v1'),
    snapshotId: Sha256Schema,
    finalizedSnapshotContentHash: Sha256Schema,
    inputManifestHash: Sha256Schema,
    boundedContentHash: Sha256Schema,
  }),
})

const QualificationWorkflowRunsSchema = Schema.Struct({
  total_count: Schema.Finite,
  workflow_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      head_sha: Schema.String,
    }),
  ),
})

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

const gitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))

const gitText = (repositoryPath: string, args: readonly string[], signal?: AbortSignal): Promise<string> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryPath, ...args],
      {
        encoding: 'utf8',
        env: gitEnvironment(),
        maxBuffer: maximumGitOutputBytes,
        signal,
      },
      (error, stdout) => {
        if (error === null) resolveGit(String(stdout).trim())
        else rejectGit(error)
      },
    )
  })

const gitBytes = (repositoryPath: string, args: readonly string[], signal?: AbortSignal): Promise<Buffer> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryPath, ...args],
      {
        encoding: 'buffer',
        env: gitEnvironment(),
        maxBuffer: 64 * 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error === null) resolveGit(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
        else rejectGit(error)
      },
    )
  })

const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const decodePreregistration = Schema.decodeUnknownResult(
  CandidateDevelopmentNextPreregistrationSchema,
  strictParseOptions,
)

export interface QualificationCandidateImmutableSourceInput {
  readonly repositoryPath: string
  readonly sourceRevision: string
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly preregistrationBytes: Uint8Array
  readonly moduleBlobOid: string
  readonly moduleBytes: Uint8Array
}

export interface QualificationCandidateImmutableSourceReceipt {
  readonly schemaVersion: 'bayn.qualification-candidate-source.v2'
  readonly moduleBlobOid: string
  readonly moduleSha256: string
  readonly preregistrationHash: string
}

const verifyCandidateSourceNovelty = (
  input: QualificationCandidateImmutableSourceInput,
): Effect.Effect<void, QualificationCollectorError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const reachableObjects = await gitText(
        input.repositoryPath,
        ['rev-list', '--objects', `${input.preregistration.preregistration.sourceRevision}^`],
        signal,
      )
      const moduleWasPreviouslyReachable = reachableObjects
        .split('\n')
        .some((line) => line.split(/\s+/, 1)[0] === input.moduleBlobOid)
      if (moduleWasPreviouslyReachable) {
        throw new Error('candidate module existed in preregistration parent ancestry')
      }
    },
    catch: (cause) =>
      collectorError(
        'candidate',
        'candidate-module-not-novel',
        'candidate module must first appear after preregistration',
        cause,
      ),
  })

/** Verify only reviewed bytes and immutable hashes; it never compiles or evaluates candidate source. */
export const verifyQualificationCandidateSource = (
  input: QualificationCandidateImmutableSourceInput,
): Effect.Effect<QualificationCandidateImmutableSourceReceipt, QualificationCollectorError> =>
  Effect.gen(function* () {
    const preregistrationValue = yield* Effect.try({
      try: () => {
        const value: unknown = JSON.parse(Buffer.from(input.preregistrationBytes).toString('utf8'))
        return value
      },
      catch: (cause) =>
        collectorError(
          'candidate',
          'preregistration-document-malformed',
          'reviewed preregistration document is not valid JSON',
          cause,
        ),
    })
    const decoded = yield* Effect.fromResult(decodePreregistration(preregistrationValue)).pipe(
      Effect.mapError((cause) =>
        collectorError(
          'candidate',
          'preregistration-document-invalid',
          'reviewed preregistration document is not a valid candidate registration',
          cause,
        ),
      ),
    )
    const { preregistration: _preregistration, ...expectedDocument } = input.preregistration
    const expectedDocumentHash = yield* Effect.fromResult(canonicalHashV1Result(expectedDocument)).pipe(
      Effect.mapError((cause) =>
        collectorError('candidate', 'preregistration-hash-failed', 'candidate registration could not be hashed', cause),
      ),
    )
    const observedDocumentHash = yield* Effect.fromResult(canonicalHashV1Result(decoded)).pipe(
      Effect.mapError((cause) =>
        collectorError('candidate', 'preregistration-hash-failed', 'candidate registration could not be hashed', cause),
      ),
    )
    if (expectedDocumentHash !== observedDocumentHash) {
      return yield* collectorError(
        'candidate',
        'preregistration-document-invalid',
        'reviewed preregistration bytes differ from the frozen registration',
      )
    }
    if (input.preregistration.priorTrialsHash === undefined) {
      return yield* collectorError(
        'candidate',
        'trial-history-hash-missing',
        'active candidate registration must bind the exact prior-trial history hash',
      )
    }
    if (
      input.preregistration.candidateOrdinal !== input.preregistration.priorTrialCount + 1 ||
      !input.preregistration.modulePath.endsWith('.ts') ||
      input.preregistration.moduleSha256 !== sha256Bytes(input.moduleBytes) ||
      !sha40.test(input.moduleBlobOid)
    ) {
      return yield* collectorError(
        'candidate',
        'candidate-source-mismatch',
        'candidate module bytes, path, or trial lineage does not match the preregistration',
      )
    }
    yield* verifyCandidateSourceNovelty(input)
    return {
      schemaVersion: 'bayn.qualification-candidate-source.v2' as const,
      moduleBlobOid: input.moduleBlobOid,
      moduleSha256: sha256Bytes(input.moduleBytes),
      preregistrationHash: sha256Bytes(input.preregistrationBytes),
    }
  })

const verifyRepositoryIntegrity = (repositoryPath: string): Effect.Effect<void, QualificationCollectorError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const [shallow, replacements, config] = await Promise.all([
        gitText(repositoryPath, ['rev-parse', '--is-shallow-repository'], signal),
        gitText(repositoryPath, ['replace', '-l'], signal),
        gitText(repositoryPath, ['config', '--list'], signal),
      ])
      if (shallow !== 'false') throw new Error('repository must not be shallow')
      if (replacements.length > 0) throw new Error('repository must not contain replacement refs')
      if (
        config
          .split('\n')
          .map((line) => line.slice(0, line.indexOf('=')))
          .some((key) => key === 'core.alternates' || key === 'extensions.objectformat')
      ) {
        throw new Error('repository object storage configuration is not trusted')
      }
    },
    catch: (cause) =>
      collectorError('repository', 'repository-integrity-invalid', 'repository integrity verification failed', cause),
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
  readonly strategyProtocolHash: string
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly preregistrationHash: string
  readonly moduleBlobOid: string
  readonly moduleSha256: string
  readonly trialHistoryHash: string
  readonly candidateSourceHash: string
  readonly boundedContentHash: string
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
      candidate.boundedContentHash !== prelock.boundedContentHash ||
      candidate.moduleSha256 !== prelock.moduleSha256 ||
      candidate.trialHistoryHash !== prelock.trialHistoryHash ||
      candidate.strategyProtocolHash !== prelock.strategyProtocolHash
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
      strategyProtocolHash: prelock.strategyProtocolHash,
      candidateOrdinal: prelock.candidateOrdinal,
      priorTrialCount: prelock.priorTrialCount,
      preregistrationHash: prelock.preregistrationHash,
      moduleBlobOid: prelock.moduleBlobOid,
      moduleSha256: prelock.moduleSha256,
      trialHistoryHash: prelock.trialHistoryHash,
      candidateSourceHash: prelock.candidateSourceHash,
      boundedContentHash: prelock.boundedContentHash,
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

export interface DeploymentRuntime {
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
  readonly moduleSha256: string
  readonly trialHistoryHash: string
  readonly candidateSourceHash: string
  readonly boundedContentHash: string
  readonly candidate: QualificationCandidateRuntime
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
  readonly candidate: QualificationCandidateRuntime
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
  readonly candidate: QualificationCandidateRuntime
  readonly inspection: MarketDataInspection
  readonly priorTrialRunIds: readonly string[]
  readonly dependencies: {
    readonly marketData: MarketDataService
    readonly journal: JournalService
    readonly evidenceStore: EvidenceStoreService
  }
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
    const strategy = {
      application: input.candidate.application,
      definition: input.candidate.application.definition,
      provenance: input.candidate.provenance,
    }
    if (attemptState === 'RECOVER_TERMINAL') {
      const recovered = yield* input.dependencies.evidenceStore
        .recover(candidate.candidateRunId, input.candidate.provenance)
        .pipe(
          Effect.mapError((cause) =>
            collectorError(
              'execution',
              'qualification-recovery-failed',
              'terminal qualification recovery failed',
              cause,
            ),
          ),
        )
      if (Option.isNone(recovered)) {
        return yield* collectorError(
          'execution',
          'qualification-terminal-missing',
          'terminal qualification evidence is missing for the recorded result',
        )
      }
      const qualification = yield* input.dependencies.evidenceStore
        .readQualification(candidate.candidateRunId)
        .pipe(
          Effect.mapError((cause) =>
            collectorError(
              'execution',
              'qualification-state-read-failed',
              'qualification state could not be re-read',
              cause,
            ),
          ),
        )
      if (Option.isNone(qualification) || qualification.value.state !== 'TERMINAL') {
        return yield* collectorError(
          'execution',
          'qualification-replay-invalid',
          'terminal qualification recovery did not return a terminal result',
        )
      }
      return {
        schemaVersion: 'bayn.qualification-execution.v1' as const,
        runId: recovered.value.evaluation.runId,
        lockId: qualification.value.result.lockId,
        resultHash: qualification.value.result.resultHash,
        verdict: qualification.value.result.verdict,
        persistence: {
          artifactCount: recovered.value.persistence.artifactCount,
          eventCount: recovered.value.persistence.eventCount,
          gateCount: recovered.value.persistence.gateCount,
        },
      }
    }

    const opened = yield* input.dependencies.evidenceStore
      .openQualification({
        lock: candidate.lock,
        inputManifest: input.inspection.manifest,
        parameters: input.candidate.application.definition.parameters,
        provenance: input.candidate.provenance,
      })
      .pipe(
        Effect.mapError((cause) =>
          collectorError('execution', 'qualification-open-failed', 'qualification lock could not be acquired', cause),
        ),
      )
    const path = yield* Effect.fromResult(decideQualificationPath(candidate.lock, opened)).pipe(
      Effect.mapError((cause) =>
        collectorError(
          'execution',
          'qualification-open-binding-invalid',
          'qualification lock binding was not exact',
          cause,
        ),
      ),
    )
    if (path._tag !== 'EvaluateAcquired') {
      return yield* collectorError(
        'execution',
        'qualification-replay-invalid',
        'qualification became terminal while the exact attempt was being acquired',
      )
    }
    const snapshot = yield* input.dependencies.marketData.load.pipe(
      Effect.mapError((cause) =>
        collectorError(
          'execution',
          'qualification-data-load-failed',
          'qualification snapshot could not be loaded',
          cause,
        ),
      ),
    )
    const evaluation = yield* Effect.fromResult(
      evaluateLockedSnapshot(strategy, input.candidate.provenance, input.inspection, candidate.lock, snapshot),
    ).pipe(
      Effect.mapError((cause) =>
        collectorError('execution', 'qualification-evaluation-failed', 'qualification evaluation failed', cause),
      ),
    )
    const reconciliation = yield* input.dependencies.journal
      .journalAndReconcile(evaluation)
      .pipe(
        Effect.mapError((cause) =>
          collectorError(
            'execution',
            'qualification-reconciliation-failed',
            'qualification reconciliation failed',
            cause,
          ),
        ),
      )
    const evidence = yield* Effect.fromResult(
      qualifyEvaluation(strategy, candidate.lock, evaluation, reconciliation),
    ).pipe(
      Effect.mapError((cause) =>
        collectorError('execution', 'qualification-analysis-failed', 'qualification analysis failed', cause),
      ),
    )
    const persistence = yield* input.dependencies.evidenceStore
      .persist({
        provenance: input.candidate.provenance,
        parameters: input.candidate.application.definition.parameters,
        evaluation,
        reconciliation,
        qualification: { lock: candidate.lock, result: evidence.qualification },
      })
      .pipe(
        Effect.mapError((cause) =>
          collectorError(
            'execution',
            'qualification-persist-failed',
            'qualification evidence could not be persisted',
            cause,
          ),
        ),
      )
    const qualification = evidence.qualification
    return {
      schemaVersion: 'bayn.qualification-execution.v1' as const,
      runId: evaluation.runId,
      lockId: qualification.lockId,
      resultHash: qualification.resultHash,
      verdict: qualification.verdict,
      persistence: {
        artifactCount: persistence.artifactCount,
        eventCount: persistence.eventCount,
        gateCount: persistence.gateCount,
      },
    }
  })

export const freezeQualificationPrelockDependencies = (
  dependencies: QualificationExecutionInput['dependencies'],
  inspection: MarketDataInspection,
  priorTrialRunIds: readonly string[],
): QualificationExecutionInput['dependencies'] => ({
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

const environmentValue = (deployment: string, name: string): string => {
  const pattern = new RegExp(`^\\s*- name: ${name}\\n\\s+value: ([^\\n]+)$`, 'gm')
  const matches = [...deployment.matchAll(pattern)]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw collectorError('configuration', 'deployment-binding-missing', `expected exactly one ${name} value`)
  }
  const value = matches[0][1].trim()
  if (!value.startsWith('"')) return value
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'string') throw new Error(`${name} deployment value is not a string`)
  return parsed
}

export interface QualificationImageBinding {
  readonly repository: string
  readonly digest: string
}

export const parseQualificationImageReference = (value: string): QualificationImageBinding | undefined => {
  const separator = value.lastIndexOf('@')
  if (separator <= 0 || separator === value.length - 1) return undefined
  const taggedRepository = value.slice(0, separator)
  const digest = value.slice(separator + 1)
  if (!imageDigest.test(digest)) return undefined
  const lastSlash = taggedRepository.lastIndexOf('/')
  const lastColon = taggedRepository.lastIndexOf(':')
  const repository = lastColon > lastSlash ? taggedRepository.slice(0, lastColon) : taggedRepository
  return repository.length === 0 ? undefined : { repository, digest }
}

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
  const deployment = await readFile(resolve(repositoryPath, 'argocd/applications/bayn/deployment.yaml'), 'utf8')
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

export const makeQualificationCandidateRuntime = (
  application: QualificationCandidateApplication,
  deployment: DeploymentRuntime,
  source: { readonly moduleSha256: string },
  preregistration: CandidateDevelopmentNextPreregistration,
): Result.Result<QualificationCandidateRuntime, QualificationCollectorError> => {
  if (preregistration.priorTrialsHash === undefined) {
    return Result.fail(
      collectorError(
        'candidate',
        'trial-history-hash-missing',
        'candidate registration has no prior-trial history hash',
      ),
    )
  }
  const definition = application.definition
  const parameterHash = hashParameters(definition.parameters)
  if (source.moduleSha256 !== deployment.strategyBehaviorHash) {
    return Result.fail(
      collectorError(
        'candidate',
        'deployment-strategy-behavior-mismatch',
        'candidate module hash differs from the embedded deployment strategy behavior hash',
      ),
    )
  }
  if (parameterHash !== deployment.strategyParameterHash) {
    return Result.fail(
      collectorError(
        'candidate',
        'deployment-strategy-parameter-mismatch',
        'candidate parameter hash differs from the embedded deployment strategy parameter hash',
      ),
    )
  }
  const provenance = makeRuntimeProvenanceResult({
    sourceRevision: deployment.sourceSha,
    image: { repository: deployment.imageRepository, digest: deployment.imageDigest },
    strategy: {
      name: definition.name,
      behaviorHash: deployment.strategyBehaviorHash,
      parameterHash,
      parameterSchemaVersion: definition.parameters.schemaVersion,
    },
  })
  if (Result.isFailure(provenance)) {
    return Result.fail(
      collectorError(
        'candidate',
        'candidate-provenance-invalid',
        'candidate provenance could not be constructed',
        provenance.failure,
      ),
    )
  }
  return Result.succeed({
    application,
    provenance: provenance.success,
    moduleSha256: source.moduleSha256,
    strategyBehaviorHash: deployment.strategyBehaviorHash,
    trialHistoryHash: preregistration.priorTrialsHash,
    boundedContentHash: preregistration.marketData.boundedContentHash,
  })
}

const collectStaticQualificationEvidence = (invocation: QualificationCollectorInvocation) =>
  Effect.gen(function* () {
    const activeCandidate = activeCandidateDevelopmentRegistration
    if (activeCandidate === null) return Option.none<StaticQualificationEvidence>()
    const lifecycle = qualificationDormancyDecisionFromLedgerState(candidateDevelopmentTrialLedgerState)
    if (!lifecycle.ok) {
      return yield* collectorError(
        'eligibility',
        'candidate-ledger-invalid',
        'active candidate ledger state is invalid; qualification remains fail-closed',
      )
    }
    if (lifecycle.decision.status !== 'ready') {
      return yield* collectorError(
        'eligibility',
        'candidate-development-not-approved',
        'qualification requires the one terminal local development approval before any qualification access',
      )
    }
    const preregistration = activeCandidate.preregistration

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
    if (embeddedBuildMetadata === undefined) {
      return yield* collectorError(
        'configuration',
        'embedded-build-missing',
        'qualification collector requires production build metadata',
      )
    }
    const imageReference = yield* requiredQualificationEnvironment(process.env, 'BAYN_QUALIFICATION_IMAGE_REFERENCE')
    const imageBinding = parseQualificationImageReference(imageReference)
    if (imageBinding === undefined || imageBinding.repository !== embeddedBuildMetadata.imageRepository) {
      return yield* collectorError(
        'configuration',
        'qualification-image-binding-invalid',
        'qualification must bind the exact locally built image and embedded repository',
      )
    }
    if (embeddedBuildMetadata.sourceRevision !== invocation.currentMainSha) {
      return yield* collectorError(
        'configuration',
        'image-source-mismatch',
        'qualification image source differs from the exact scheduled source',
      )
    }

    yield* verifyRepositoryIntegrity(repositoryPath)
    const deployment = yield* Effect.tryPromise({
      try: () => loadDeploymentRuntime(repositoryPath),
      catch: (cause) =>
        cause instanceof QualificationCollectorError
          ? cause
          : collectorError('configuration', 'deployment-read-failed', 'deployment runtime could not be read', cause),
    })
    const qualificationRuntime: DeploymentRuntime = {
      ...deployment,
      sourceSha: invocation.currentMainSha,
      imageRepository: imageBinding.repository,
      imageDigest: imageBinding.digest,
      strategyBehaviorHash: embeddedBuildMetadata.strategyBehaviorHash,
      strategyParameterHash: embeddedBuildMetadata.strategyParameterHash,
    }
    yield* Effect.tryPromise({
      try: (signal) =>
        gitText(
          repositoryPath,
          ['merge-base', '--is-ancestor', preregistration.preregistration.sourceRevision, invocation.currentMainSha],
          signal,
        ),
      catch: (cause) =>
        collectorError(
          'repository',
          'preregistration-lineage-invalid',
          'preregistration is not an ancestor of current main',
          cause,
        ),
    })

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
          gitText(
            repositoryPath,
            ['rev-parse', `${qualificationRuntime.sourceSha}:${preregistration.modulePath}`],
            signal,
          ),
          gitBytes(
            repositoryPath,
            ['cat-file', 'blob', `${qualificationRuntime.sourceSha}:${preregistration.modulePath}`],
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
      staticGit.head !== invocation.currentMainSha ||
      staticGit.originMain !== invocation.currentMainSha ||
      rawOriginUrls.length !== 1 ||
      observedRepository !== trustedRepository ||
      rewriteKeys.length !== 0
    ) {
      return yield* collectorError(
        'repository',
        'repository-binding-invalid',
        'exact checked-out main binding is invalid',
      )
    }
    if (
      staticGit.preregistrationBlobOid !== preregistration.preregistration.blobOid ||
      staticGit.moduleBlobOid.length !== 40 ||
      sha256Bytes(staticGit.moduleBytes) !== preregistration.moduleSha256
    ) {
      return yield* collectorError(
        'repository',
        'preregistration-source-mismatch',
        'preregistration document or candidate module differs from the reviewed immutable source',
      )
    }
    const candidateSource = yield* verifyQualificationCandidateSource({
      repositoryPath,
      sourceRevision: qualificationRuntime.sourceSha,
      preregistration,
      preregistrationBytes: staticGit.preregistrationBytes,
      moduleBlobOid: staticGit.moduleBlobOid,
      moduleBytes: staticGit.moduleBytes,
    })
    const candidate = yield* Effect.fromResult(
      makeQualificationCandidateRuntime(
        activeCandidate.application,
        qualificationRuntime,
        candidateSource,
        preregistration,
      ),
    )
    const candidateSourceHash = yield* Effect.fromResult(
      canonicalHashV1Result({
        schemaVersion: 'bayn.qualification-candidate-source-binding.v1',
        candidateOrdinal: preregistration.candidateOrdinal,
        sourceRevision: qualificationRuntime.sourceSha,
        modulePath: preregistration.modulePath,
        moduleBlobOid: candidateSource.moduleBlobOid,
        moduleSha256: candidateSource.moduleSha256,
        preregistrationHash: candidateSource.preregistrationHash,
        trialHistoryHash: candidate.trialHistoryHash,
        strategyProtocolHash: makeStrategyProtocolHash(candidate.provenance.strategy),
        snapshotId: preregistration.marketData.snapshotId,
        inputManifestHash: preregistration.marketData.inputManifestHash,
        boundedContentHash: candidate.boundedContentHash,
      }),
    ).pipe(
      Effect.mapError((cause) =>
        collectorError(
          'candidate',
          'candidate-source-hash-failed',
          'candidate source binding could not be hashed',
          cause,
        ),
      ),
    )

    yield* verifyRepositoryIntegrity(repositoryPath)
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
    const finalRepository = finalOrigins.length === 1 ? yield* repositoryFromOrigin(finalOrigins[0] ?? '') : undefined
    if (
      finalGit.head !== invocation.currentMainSha ||
      finalGit.originMain !== invocation.currentMainSha ||
      finalOrigins.length !== 1 ||
      finalRepository !== trustedRepository ||
      finalGit.configuration.split('\n').some((line) => line.startsWith('url.') && line.includes('.insteadof='))
    ) {
      return yield* collectorError(
        'repository',
        'repository-binding-changed',
        'repository changed during evidence collection',
      )
    }
    const githubRunId = yield* requiredQualificationEnvironment(process.env, 'GITHUB_RUN_ID')
    const githubRunAttempt = yield* positiveIntegerQualificationEnvironment(process.env, 'GITHUB_RUN_ATTEMPT')
    return Option.some<StaticQualificationEvidence>({
      preregistration,
      preregistrationHash: candidateSource.preregistrationHash,
      repositoryPath,
      repository,
      currentMainSha: invocation.currentMainSha,
      sourceSha: qualificationRuntime.sourceSha,
      githubRunId,
      githubRunAttempt,
      moduleBlobOid: candidateSource.moduleBlobOid,
      moduleSha256: candidateSource.moduleSha256,
      trialHistoryHash: candidate.trialHistoryHash,
      candidateSourceHash,
      boundedContentHash: candidate.boundedContentHash,
      candidate,
      deployment: qualificationRuntime,
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
  if (!Number.isSafeInteger(currentRunId) || currentRunId < 1)
    throw new TypeError('current GitHub Actions run ID is invalid')
  const blocking = new Set<string>()
  for (const run of runs) {
    if (!Number.isSafeInteger(run.id) || run.id < 1) throw new TypeError('GitHub Actions run ID is invalid')
    if (run.id !== currentRunId && (run.status === 'in_progress' || run.id < currentRunId)) blocking.add(String(run.id))
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
      if (!Number.isSafeInteger(currentRunNumber) || currentRunNumber < 1)
        throw new Error('current GitHub Actions run ID is invalid')
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
        if (response.headers.get('link')?.includes('rel="next"') === true)
          throw new Error('GitHub Actions run query exceeded one bounded page')
        const raw: unknown = await response.json()
        const decoded = Schema.decodeUnknownResult(QualificationWorkflowRunsSchema, strictParseOptions)(raw)
        if (Result.isFailure(decoded)) throw decoded.failure
        if (
          !Number.isSafeInteger(decoded.success.total_count) ||
          decoded.success.total_count < 0 ||
          decoded.success.total_count !== decoded.success.workflow_runs.length
        )
          throw new Error('GitHub Actions run query returned incomplete evidence')
        for (const run of decoded.success.workflow_runs) {
          if (!Number.isSafeInteger(run.id) || run.id < 1 || !sha40.test(run.head_sha))
            throw new Error('GitHub Actions run query returned invalid identity')
          runs.push({ id: run.id, status })
        }
      }
      return blockingQualificationWorkflowRunIds(currentRunNumber, runs)
    },
    catch: (cause) =>
      collectorError('eligibility', 'github-attempt-read-failed', 'active workflow attempts could not be read', cause),
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
      const dependencies = yield* Effect.all({ marketData: MarketData, journal: Journal, evidenceStore: EvidenceStore })
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
        strategyBehaviorHash: staticEvidence.candidate.provenance.strategy.behaviorHash,
        strategyParameterHash: staticEvidence.candidate.provenance.strategy.parameterHash,
        strategyProtocolHash: makeStrategyProtocolHash(staticEvidence.candidate.provenance.strategy),
        candidateOrdinal: staticEvidence.preregistration.candidateOrdinal,
        priorTrialCount: staticEvidence.preregistration.priorTrialCount,
        preregistrationHash: staticEvidence.preregistrationHash,
        moduleBlobOid: staticEvidence.moduleBlobOid,
        moduleSha256: staticEvidence.moduleSha256,
        trialHistoryHash: staticEvidence.trialHistoryHash,
        candidateSourceHash: staticEvidence.candidateSourceHash,
        boundedContentHash: staticEvidence.boundedContentHash,
        activeAttemptRunIds,
        githubRunId: staticEvidence.githubRunId,
        githubRunAttempt: staticEvidence.githubRunAttempt,
        plan,
        inspection,
        priorTrialRunIds,
        preregistration: staticEvidence.preregistration,
        candidate: staticEvidence.candidate,
        dependencies,
      }
      collected = value
      return value
    }),
    verifyCandidate: (prelock) =>
      Effect.fromResult(
        verifyQualificationCandidateBinding(
          prelock.preregistration,
          prelock.candidate,
          {
            sourceRevision: prelock.sourceSha,
            image: { repository: prelock.imageRepository, digest: prelock.imageDigest },
          },
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
        if (collected !== prelock)
          return yield* collectorError(
            'execution',
            'prelock-evidence-replaced',
            'qualification execution must consume the exact collected prelock evidence',
          )
        return yield* executeQualificationAttempt(
          {
            plan: prelock.plan,
            candidate: prelock.candidate,
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
