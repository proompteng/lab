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
  type QualificationAuditReaders,
} from './model'
import { acquireAuditRepositoryClient } from './repository'
import { acquireAuditSignalClient, loadAuditSignal } from './signal'
import { acquireAuditSignalReplicaClient, readAuditSignalAccess } from './signal-access'

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
})

export const runQualificationAudit = <R>(input: AuditConfig, readers: QualificationAuditReaders<R>) =>
  Effect.gen(function* () {
    const database = yield* readers.readDatabase(input.runId)
    const inputManifestArtifact = database.artifacts.find((artifact) => artifact.name === 'input-manifest')
    if (inputManifestArtifact === undefined) {
      return yield* qualificationAuditCommandError('audit', 'input-manifest artifact is missing')
    }
    const manifest = yield* decodeInputManifestArtifact(inputManifestArtifact.payload)
    const protocol = database.protocol.parameters
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
