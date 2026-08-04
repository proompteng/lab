import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { Effect } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'
import { FileSystem } from 'effect'

import { auditQualification } from '../../audit/run'
import { makeQualificationDossier } from '../../audit/dossier'
import { decodeInputManifestArtifact } from '../../evidence-contracts'
import { acquireAuditDatabaseClient, readAuditDatabase } from './database'
import {
  qualificationAuditCommandError,
  type AuditConfig,
  type QualificationAuditAcquirers,
  type QualificationAuditCommandError,
  type QualificationAuditReaders,
} from './model'
import { acquireAuditRepositoryClient } from './repository'
import { acquireAuditSignalClient, loadAuditSignal } from './signal'
import { acquireAuditSignalReplicaClient, readAuditSignalAccess } from './signal-access'
import { activeStrategyBehaviorHash, bindReviewedStrategySource, makeActiveStrategyApplication } from '../../strategy'
import { loadReviewedStrategyApplication } from '../../candidate-development-local/source-module'
import type { StrategyApplication } from '../../strategy/core'
import { hashParameters } from '../../protocol'

const sha256Pattern = /^[0-9a-f]{64}$/

const verifiedCandidateModulePath = (input: AuditConfig): Effect.Effect<string, QualificationAuditCommandError> =>
  Effect.gen(function* () {
    const repositoryRoot = yield* Effect.tryPromise({
      try: () => realpath(resolve(input.repositoryPath)),
      catch: (cause) =>
        qualificationAuditCommandError('repository', 'audit repository path could not be resolved', cause),
    })
    const modulePath = yield* Effect.tryPromise({
      try: () => realpath(resolve(input.candidateModulePath)),
      catch: (cause) =>
        qualificationAuditCommandError('repository', 'candidate strategy module path could not be resolved', cause),
    })
    const relativeModulePath = relative(repositoryRoot, modulePath)
    if (
      relativeModulePath.length === 0 ||
      relativeModulePath === '..' ||
      relativeModulePath.startsWith(`..${sep}`) ||
      isAbsolute(relativeModulePath)
    ) {
      return yield* Effect.fail(
        qualificationAuditCommandError(
          'repository',
          'candidate strategy module must resolve inside the audit repository',
        ),
      )
    }
    return modulePath
  })

const loadAuditStrategyApplication = (
  input: AuditConfig,
  sourceRevision: string,
  protocol: Parameters<typeof makeActiveStrategyApplication>[0],
  expectedBehaviorHash: string,
): Effect.Effect<StrategyApplication<any, any, any>, QualificationAuditCommandError> => {
  if (input.candidateModulePath.trim().length === 0) {
    return expectedBehaviorHash === activeStrategyBehaviorHash
      ? Effect.succeed(makeActiveStrategyApplication(protocol))
      : Effect.fail(
          qualificationAuditCommandError(
            'configuration',
            'BAYN_AUDIT_CANDIDATE_MODULE_PATH and BAYN_AUDIT_CANDIDATE_MODULE_SHA256 are required for the persisted strategy behavior',
          ),
        )
  }
  if (!sha256Pattern.test(input.candidateModuleSha256)) {
    return Effect.fail(
      qualificationAuditCommandError(
        'configuration',
        'BAYN_AUDIT_CANDIDATE_MODULE_SHA256 must be a lowercase SHA-256 digest',
      ),
    )
  }
  return Effect.gen(function* () {
    const modulePath = yield* verifiedCandidateModulePath(input)
    const moduleBytes = yield* Effect.tryPromise({
      try: (signal) => readFile(modulePath, { signal }),
      catch: (cause) =>
        qualificationAuditCommandError('repository', 'candidate strategy module could not be read', cause),
    })
    const observedModuleSha256 = createHash('sha256').update(moduleBytes).digest('hex')
    if (observedModuleSha256 !== input.candidateModuleSha256) {
      return yield* Effect.fail(
        qualificationAuditCommandError(
          'repository',
          'candidate strategy module bytes do not match the qualification provenance',
        ),
      )
    }
    if (observedModuleSha256 !== expectedBehaviorHash) {
      return yield* Effect.fail(
        qualificationAuditCommandError(
          'repository',
          'candidate strategy module bytes do not match the persisted behavior identity',
        ),
      )
    }
    const application = yield* loadReviewedStrategyApplication(modulePath, sourceRevision).pipe(
      Effect.timeoutOrElse({
        duration: input.operationTimeoutMs,
        orElse: () =>
          Effect.fail(
            qualificationAuditCommandError(
              'repository',
              'candidate strategy application load exceeded the configured audit timeout',
            ),
          ),
      }),
      Effect.mapError((cause) =>
        qualificationAuditCommandError('repository', 'candidate strategy application could not be loaded', cause),
      ),
    )
    if (hashParameters(application.definition.parameters) !== hashParameters(protocol)) {
      return yield* Effect.fail(
        qualificationAuditCommandError(
          'repository',
          'candidate strategy parameters do not match the persisted qualification protocol',
        ),
      )
    }
    return bindReviewedStrategySource(application, {
      sourceRevision,
      modulePath,
      moduleSha256: input.candidateModuleSha256,
    })
  })
}

export const liveQualificationAuditAcquirers: QualificationAuditAcquirers<
  FileSystem.FileSystem | Reactivity.Reactivity | ChildProcessSpawner.ChildProcessSpawner
> = {
  database: acquireAuditDatabaseClient,
  signal: acquireAuditSignalClient,
  signalReplica: acquireAuditSignalReplicaClient,
  repository: acquireAuditRepositoryClient,
}

export const makeQualificationAuditReaders = <R>(
  input: AuditConfig,
  acquirers: QualificationAuditAcquirers<R>,
): QualificationAuditReaders<R> => ({
  readDatabase: (runId) => readAuditDatabase(input, runId, acquirers.database),
  loadSignal: (manifest, protocol) => loadAuditSignal(input, manifest, protocol, acquirers.signal),
  readSignalAccess: (database, finalizedAt, signalTables) =>
    readAuditSignalAccess(input, database, finalizedAt, signalTables, acquirers.signalReplica),
  auditRepository: (sourceRevision, lockCreatedAt, resultIdentity) =>
    acquirers
      .repository(input)
      .pipe(Effect.flatMap((repository) => repository.audit(sourceRevision, lockCreatedAt, resultIdentity))),
  verifySourceCheckout: (sourceRevision, candidateModulePath) =>
    acquirers
      .repository(input)
      .pipe(Effect.flatMap((repository) => repository.verifySourceCheckout(sourceRevision, candidateModulePath))),
})

export const runQualificationAudit = <R>(input: AuditConfig, readers: QualificationAuditReaders<R>) =>
  Effect.gen(function* () {
    const database = yield* readers.readDatabase(input.runId)
    const inputManifestArtifact = database.artifacts.find((artifact) => artifact.name === 'input-manifest')
    if (inputManifestArtifact === undefined) {
      return yield* qualificationAuditCommandError('audit', 'input-manifest artifact is missing')
    }
    const manifest = yield* decodeInputManifestArtifact(inputManifestArtifact.payload)
    const candidateModulePath = input.candidateModulePath.trim()
    yield* readers.verifySourceCheckout(
      database.run.sourceRevision,
      candidateModulePath.length === 0 ? undefined : resolve(candidateModulePath),
    )
    const protocol = database.protocol.parameters
    const application = yield* loadAuditStrategyApplication(
      input,
      database.run.sourceRevision,
      protocol,
      database.protocol.behaviorHash,
    )
    const signal = yield* readers.loadSignal(manifest, protocol)
    const signalAccess = yield* readers.readSignalAccess(
      database,
      manifest.finalizedSnapshot.finalizedAt,
      manifest.tables,
    )
    const result = database.qualification.result
    const repository = yield* readers.auditRepository(
      database.run.sourceRevision,
      database.qualification.lockCreatedAt,
      [database.run.runId, result.resultHash, result.analysis.analysisHash],
    )
    const auditInput = {
      bars: signal.bars,
      manifest: signal.manifest,
      protocol,
      application,
      database,
      signalReplicas: signalAccess.replicas,
      signalAccess: signalAccess.access,
      signalPrincipals: { candidate: input.signalUsername, publishers: [input.signalPublisherUsername] },
      repository,
    }
    return input.output === 'dossier'
      ? yield* Effect.fromResult(makeQualificationDossier(auditInput)).pipe(
          Effect.mapError((cause) =>
            qualificationAuditCommandError('audit', 'qualification dossier construction failed', cause),
          ),
        )
      : yield* Effect.fromResult(auditQualification(auditInput)).pipe(
          Effect.mapError((cause) =>
            qualificationAuditCommandError('audit', 'qualification audit evaluation failed', cause),
          ),
        )
  })
