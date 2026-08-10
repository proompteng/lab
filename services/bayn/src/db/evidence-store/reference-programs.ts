import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Option, Schema } from 'effect'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { RuntimeProvenance } from '../../contracts'
import type { InputManifest, Protocol } from '../../types'
import type { PersistenceReceipt, StoredEvidenceRows } from '../evidence-recovery'
import {
  ensureSnapshotReference as ensureSnapshotReferenceRow,
  renderSnapshotReferenceIssue,
  snapshotReferenceIssueTags,
} from '../snapshot-reference'
import { databaseError, persistencePlanDatabaseError, type DatabaseError } from './errors'
import type { EvidenceStatements } from './evidence-statements'
import type { PersistencePlan } from './persistence-model'
import { validatePersistenceReceipt, validateProtocolReference } from './persistence-receipt'
import { Pipeable } from '../../pipeable'

export interface EvidenceReferencePrograms {
  readonly ensureProtocolReference: (input: {
    readonly protocolHash: string
    readonly provenance: RuntimeProvenance
    readonly parameters: Protocol
  }) => Effect.Effect<void, Cause.NoSuchElementError | DatabaseError | Schema.SchemaError | SqlError>
  readonly ensureSnapshotReference: (
    inputManifest: InputManifest,
  ) => Effect.Effect<void, DatabaseError | Schema.SchemaError | SqlError>
  readonly readReceipt: (
    plan: PersistencePlan,
    deduplicated: boolean,
  ) => Effect.Effect<PersistenceReceipt, DatabaseError | Schema.SchemaError | SqlError>
  readonly loadStoredRows: (
    runId: string,
  ) => Effect.Effect<Option.Option<StoredEvidenceRows>, Cause.NoSuchElementError | Schema.SchemaError | SqlError>
}

const makeEvidenceReferenceProgramsDataFirst = (
  sql: PgClient.PgClient,
  statements: EvidenceStatements,
): EvidenceReferencePrograms => {
  const ensureProtocolReference: EvidenceReferencePrograms['ensureProtocolReference'] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO protocol_locks (
          protocol_hash,
          schema_version,
          strategy_name,
          behavior_hash,
          parameter_hash,
          parameters
        ) VALUES (
          ${input.protocolHash},
          ${input.provenance.strategy.parameterSchemaVersion},
          ${input.provenance.strategy.name},
          ${input.provenance.strategy.behaviorHash},
          ${input.provenance.strategy.parameterHash},
          ${sql.json(input.parameters)}
        )
        ON CONFLICT (protocol_hash) DO NOTHING
      `
      const protocol = yield* statements.getProtocol({ protocolHash: input.protocolHash })
      yield* Effect.fromResult(validateProtocolReference(input, protocol)).pipe(
        Effect.mapError((failure) => persistencePlanDatabaseError('protocol-lock', failure)),
      )
    })

  const ensureSnapshotReference: EvidenceReferencePrograms['ensureSnapshotReference'] = (inputManifest) =>
    ensureSnapshotReferenceRow(sql, inputManifest).pipe(
      Effect.catchTag(snapshotReferenceIssueTags, (cause) =>
        Effect.fail(databaseError('invariant', 'snapshot-reference', renderSnapshotReferenceIssue(cause), cause)),
      ),
    )

  const readReceipt: EvidenceReferencePrograms['readReceipt'] = (plan, deduplicated) =>
    Effect.gen(function* () {
      const runId = plan.evaluation.runId
      const receipts = yield* statements.getReceipt({ runId })
      const artifacts = yield* statements.getArtifactReferences({ runId })
      const events = yield* statements.getEventReferences({ runId })
      const gates = yield* statements.getGateReferences({ runId })
      const statuses = yield* statements.getStatusReferences({ runId })
      return yield* Effect.fromResult(
        validatePersistenceReceipt(plan, { receipts, artifacts, events, gates, statuses }, deduplicated),
      ).pipe(Effect.mapError((failure) => persistencePlanDatabaseError('read-receipt', failure)))
    })

  const loadStoredRows: EvidenceReferencePrograms['loadStoredRows'] = (runId) =>
    Effect.gen(function* () {
      const receipts = yield* statements.getReceipt({ runId })
      if (receipts.length === 0) return Option.none<StoredEvidenceRows>()
      const receipt = receipts[0]
      if (receipt === undefined) return Option.none<StoredEvidenceRows>()
      const protocol = yield* statements.getProtocol({ protocolHash: receipt.protocol_hash })
      const artifacts = yield* statements.getArtifactReferences({ runId })
      const events = yield* statements.getEventReferences({ runId })
      const gates = yield* statements.getGateReferences({ runId })
      const statuses = yield* statements.getStatusReferences({ runId })
      return Option.some({ receipts, protocol, artifacts, events, gates, statuses } satisfies StoredEvidenceRows)
    })

  return { ensureProtocolReference, ensureSnapshotReference, readReceipt, loadStoredRows }
}

export const makeEvidenceReferencePrograms = Pipeable.dual(2, makeEvidenceReferenceProgramsDataFirst)
