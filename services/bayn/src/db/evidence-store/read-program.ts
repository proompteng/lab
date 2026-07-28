import { Effect, Option } from 'effect'

import type { RuntimeProvenance } from '../../contracts'
import {
  completeEvidenceRecovery,
  prepareEvidenceRecovery,
  validateStoredEvidence,
  type RecoveredEvaluationEvidence,
  type StoredEvaluationEvidence,
} from '../evidence-recovery'
import { databaseError, ensure, evidenceRecoveryDatabaseError, runDatabase } from './errors'
import type { EvidenceStatements } from './evidence-statements'
import type { ArtifactItemPage, EvidenceStoreService } from './model'
import {
  decideArtifactPageRequest,
  decodeRunId,
  renderEvidenceReadInputFailure,
  type EvidenceReadInputFailure,
} from './read-decisions'
import type { EvidenceReferencePrograms } from './reference-programs'

const readInputDatabaseError = (operation: string, cause: EvidenceReadInputFailure) =>
  databaseError(
    cause._tag === 'InvalidRunId' ? 'decode' : 'invariant',
    operation,
    renderEvidenceReadInputFailure(cause),
    cause,
  )

export interface EvidenceReadPrograms {
  readonly read: EvidenceStoreService['read']
  readonly readArtifactItems: EvidenceStoreService['readArtifactItems']
  readonly recover: EvidenceStoreService['recover']
}

export const makeEvidenceReadPrograms = (
  statements: EvidenceStatements,
  references: EvidenceReferencePrograms,
): EvidenceReadPrograms => {
  const readStored = (operation: string, runId: string) =>
    Effect.gen(function* () {
      const rows = yield* references.loadStoredRows(runId)
      if (Option.isNone(rows)) return Option.none<StoredEvaluationEvidence>()
      const stored = yield* Effect.fromResult(validateStoredEvidence(runId, rows.value)).pipe(
        Effect.mapError((issue) => evidenceRecoveryDatabaseError(operation, issue)),
      )
      return Option.some(stored)
    })

  const read: EvidenceStoreService['read'] = (runId) =>
    runDatabase(
      'read-evidence',
      Effect.fromResult(decodeRunId(runId)).pipe(
        Effect.mapError((cause) => readInputDatabaseError('read-evidence', cause)),
        Effect.flatMap((decodedRunId) => readStored('read-evidence', decodedRunId)),
      ),
    )

  const readArtifactItems: EvidenceStoreService['readArtifactItems'] = (input) =>
    runDatabase(
      'read-artifact-items',
      Effect.fromResult(decideArtifactPageRequest(input)).pipe(
        Effect.mapError((cause) => readInputDatabaseError('read-artifact-items', cause)),
        Effect.flatMap(({ runId, artifactName, afterOrdinal, limit }) =>
          Effect.gen(function* () {
            const metadata = yield* statements.getArtifactSeriesMetadata({ runId, artifactName })
            if (metadata.length === 0) return Option.none<ArtifactItemPage>()
            yield* ensure(metadata.length === 1, 'read-artifact-items', 'artifact series metadata is duplicated')
            const [series] = metadata
            if (series === undefined) {
              return yield* Effect.fail(
                databaseError('invariant', 'read-artifact-items', 'artifact series metadata disappeared'),
              )
            }
            const rows = yield* statements.getArtifactItems({ runId, artifactName, afterOrdinal, limit })
            yield* ensure(
              rows.every((row, index) => row.ordinal === afterOrdinal + index + 1),
              'read-artifact-items',
              'artifact page is not contiguous',
            )
            const last = rows.at(-1)?.ordinal
            return Option.some({
              runId,
              artifactName,
              schemaVersion: series.schema_version,
              contentHash: series.content_hash,
              itemCount: series.item_count,
              items: rows,
              nextAfterOrdinal: last !== undefined && last < series.item_count - 1 ? last : null,
            } satisfies ArtifactItemPage)
          }),
        ),
      ),
    )

  const recover = (runId: string, provenance: RuntimeProvenance) =>
    runDatabase(
      'recover-evidence',
      Effect.fromResult(decodeRunId(runId)).pipe(
        Effect.mapError((cause) => readInputDatabaseError('recover-evidence', cause)),
        Effect.flatMap((decodedRunId) =>
          Effect.gen(function* () {
            const rows = yield* references.loadStoredRows(decodedRunId)
            if (Option.isNone(rows)) return Option.none<RecoveredEvaluationEvidence>()
            const prepared = yield* Effect.fromResult(
              prepareEvidenceRecovery({ runId: decodedRunId, provenance, rows: rows.value }),
            ).pipe(Effect.mapError((issue) => evidenceRecoveryDatabaseError('recover-evidence', issue)))
            const snapshot = yield* statements.getSnapshot({ snapshotId: prepared.stored.run.snapshotId })
            const recovered = yield* Effect.fromResult(completeEvidenceRecovery(prepared, snapshot)).pipe(
              Effect.mapError((issue) => evidenceRecoveryDatabaseError('recover-evidence', issue)),
            )
            return Option.some(recovered)
          }),
        ),
      ),
    )

  return { read, readArtifactItems, recover }
}
