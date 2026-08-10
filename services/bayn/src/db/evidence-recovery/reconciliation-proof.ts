import { Result } from 'effect'

import { buildLedgerPlan } from '../../ledger-plan'
import { reconcileMarkedEquity, type MarkedEquityProof } from '../../simulation-reconciliation'
import type { InputManifest } from '../../types'
import {
  cardinalityOnlyLedger,
  type EvidenceRecoveryIssue,
  type PreparedEvidenceRecovery,
  type StoredSnapshotRow,
} from './model'
import { canonicalHash, mismatch } from './shared'
import { Pipeable } from '../../pipeable'

const validateRecoveredSnapshotReferenceDataFirst = (
  row: StoredSnapshotRow,
  inputManifest: InputManifest,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const snapshot = inputManifest.finalizedSnapshot
    const facts = [
      ['snapshotId', row.snapshot_id, snapshot.snapshotId],
      ['schemaVersion', row.schema_version, snapshot.schemaVersion],
      ['databaseName', row.database_name, inputManifest.database],
      ['tableName', row.table_name, inputManifest.tables.bars],
      ['datasetVersion', row.dataset_version, snapshot.publicationSchemaVersion],
      ['source', row.source, snapshot.source],
      ['sourceFeed', row.source_feed, snapshot.sourceFeed],
      ['adjustment', row.adjustment, snapshot.adjustment],
      ['contentHash', row.content_hash, snapshot.contentHash],
      ['rowCount', row.row_count, snapshot.rowCount],
      ['firstSession', row.first_session, snapshot.firstSession],
      ['lastSession', row.last_session, snapshot.lastSession],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* mismatch('snapshot', [path], observed, expected)
    }
    const observedManifestHash = yield* canonicalHash('snapshot-manifest', row.manifest, 'stored')
    const expectedManifestHash = yield* canonicalHash('snapshot-manifest', snapshot, 'input-manifest')
    if (observedManifestHash !== expectedManifestHash) {
      return yield* mismatch('snapshot', ['manifestHash'], observedManifestHash, expectedManifestHash)
    }
  })

export const validateRecoveredSnapshotReference = Pipeable.dual(2, validateRecoveredSnapshotReferenceDataFirst)

export const reconcileRecoveredEvidence = (
  prepared: PreparedEvidenceRecovery,
): Result.Result<MarkedEquityProof, EvidenceRecoveryIssue> => {
  const { decoded } = prepared
  return Result.mapError(
    reconcileMarkedEquity({
      runId: prepared.runId,
      initialCapitalMicros: decoded.evaluation.initialCapitalMicros,
      evaluatorTotalFeesMicros: decoded.evaluation.strategy.totalFeesMicros,
      evaluatorEndingEquityMicros: decoded.evaluation.strategy.endingEquityMicros,
      events: decoded.events,
      simulation: {
        schemaVersion: 'bayn.simulation-trace.v3',
        executionModel: decoded.orders.executionModel,
        costMultiplierMicros: decoded.orders.costMultiplierMicros,
        orders: decoded.orders.items,
        cashChanges: decoded.cashChanges.items,
        dailyMarks: decoded.dailyMarks.items,
      },
    }),
    (issues): EvidenceRecoveryIssue => ({ _tag: 'SimulationFailure', issues }),
  )
}

export const validateRecoveredReconciliationShape = (
  prepared: PreparedEvidenceRecovery,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { reconciliation } = prepared.decoded
    if (reconciliation.runId !== prepared.runId) {
      return yield* mismatch('reconciliation', ['runId'], reconciliation.runId, prepared.runId)
    }
    const ledgerPlan = yield* buildLedgerPlan(
      {
        runId: prepared.runId,
        initialCapitalMicros: prepared.decoded.evaluation.initialCapitalMicros,
        inputManifest: prepared.decoded.inputManifest,
        events: prepared.decoded.events,
      },
      cardinalityOnlyLedger,
    ).pipe(
      Result.mapError(
        (cause): EvidenceRecoveryIssue => ({
          _tag: 'ComputationFailure',
          operation: 'build-ledger-plan',
          cause,
        }),
      ),
    )
    if (reconciliation.accountCount !== ledgerPlan.accounts.length) {
      return yield* mismatch(
        'reconciliation',
        ['accountCount'],
        reconciliation.accountCount,
        ledgerPlan.accounts.length,
      )
    }
    if (reconciliation.transferCount !== ledgerPlan.transfers.length) {
      return yield* mismatch(
        'reconciliation',
        ['transferCount'],
        reconciliation.transferCount,
        ledgerPlan.transfers.length,
      )
    }
  })
