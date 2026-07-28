import { PgClient } from '@effect/sql-pg'
import { Schema } from 'effect'
import { SqlSchema } from 'effect/unstable/sql'

import { FinalizedSnapshotProvenanceSchema } from '../../contracts'
import { EvaluationEventSchema } from '../../evidence-contracts'
import { ProtocolSchema } from '../../protocol'

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const GitRevision = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const GateScalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])

const RunRequest = Schema.Struct({ runId: Sha256 })
const InsertedRun = Schema.Struct({ run_id: Sha256 })
const HealthRow = Schema.Struct({ value: Schema.Literal(1) })
const ProtocolRow = Schema.Struct({
  protocol_hash: Sha256,
  schema_version: Schema.String,
  strategy_name: Schema.String,
  behavior_hash: Sha256,
  parameter_hash: Sha256,
  parameters: ProtocolSchema,
})
const SnapshotRow = Schema.Struct({
  snapshot_id: Sha256,
  schema_version: Schema.Literal('bayn.finalized-snapshot.v3'),
  database_name: Schema.Literal('signal'),
  table_name: Schema.Literal('adjusted_daily_bars_v2'),
  dataset_version: Schema.Literal('signal.adjusted-daily-snapshot.v2'),
  source: Schema.Literal('alpaca'),
  source_feed: Schema.Literal('sip'),
  adjustment: Schema.Literal('all'),
  content_hash: Sha256,
  row_count: PositiveInteger,
  first_session: Schema.String,
  last_session: Schema.String,
  manifest: FinalizedSnapshotProvenanceSchema,
})
const ReceiptRow = Schema.Struct({
  run_id: Sha256,
  protocol_hash: Sha256,
  snapshot_id: Sha256,
  evaluation_schema_version: Schema.String,
  source_revision: GitRevision,
  image_repository: Schema.String,
  image_digest: ImageDigest,
  strategy_name: Schema.String,
  initial_capital_micros: Schema.String,
  status: Schema.Literal('COMPLETE'),
  expected_artifact_count: PositiveInteger,
  expected_event_count: NonNegativeInteger,
  expected_gate_count: PositiveInteger,
  artifact_count: NonNegativeInteger,
  event_count: NonNegativeInteger,
  gate_count: NonNegativeInteger,
})
const ArtifactReferenceRow = Schema.Struct({
  artifact_name: Schema.String,
  schema_version: Schema.String,
  content_hash: Sha256,
  payload: Schema.Json,
})
const ArtifactSeriesMetadataRow = Schema.Struct({
  schema_version: Schema.String,
  content_hash: Sha256,
  item_count: NonNegativeInteger,
})
const ArtifactItemRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  payload: Schema.Json,
})
const EventReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  event_id: Sha256,
  event_kind: Schema.Literals(['decision', 'fill', 'fee', 'cash-yield']),
  content_hash: Sha256,
  payload: EvaluationEventSchema,
})
const GateReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  gate_name: Schema.String,
  passed: Schema.Boolean,
  actual: GateScalar,
  required: GateScalar,
  content_hash: Sha256,
})
const StatusReferenceRow = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('WRITING'),
    detail: Schema.Struct({
      artifactCount: PositiveInteger,
      eventCount: NonNegativeInteger,
      gateCount: PositiveInteger,
    }),
  }),
  Schema.Struct({
    status: Schema.Literal('COMPLETE'),
    detail: Schema.Struct({
      reconciliationExact: Schema.Literal(true),
      verdict: Schema.Literals(['PASS', 'FAIL_CLOSED']),
    }),
  }),
])

export const makeEvidenceStatements = (sql: PgClient.PgClient) => {
  const health = SqlSchema.findOne({
    Request: Schema.Void,
    Result: HealthRow,
    execute: () => sql`SELECT 1::integer AS value`,
  })
  const getProtocol = SqlSchema.findOne({
    Request: Schema.Struct({ protocolHash: Sha256 }),
    Result: ProtocolRow,
    execute: ({ protocolHash }) => sql`SELECT * FROM protocol_locks WHERE protocol_hash = ${protocolHash}`,
  })
  const getSnapshot = SqlSchema.findOne({
    Request: Schema.Struct({ snapshotId: Sha256 }),
    Result: SnapshotRow,
    execute: ({ snapshotId }) => sql`
      SELECT
        snapshot_id,
        schema_version,
        database_name,
        table_name,
        dataset_version,
        source,
        source_feed,
        adjustment,
        content_hash,
        row_count::integer AS row_count,
        first_session::text,
        last_session::text,
        manifest
      FROM snapshot_references
      WHERE snapshot_id = ${snapshotId}
    `,
  })
  const insertRun = SqlSchema.findAll({
    Request: Schema.Struct({
      runId: Sha256,
      protocolHash: Sha256,
      snapshotId: Sha256,
      evaluationSchemaVersion: Schema.String,
      sourceRevision: Schema.String,
      imageRepository: Schema.String,
      imageDigest: Schema.String,
      strategyName: Schema.String,
      initialCapitalMicros: Schema.String,
      artifactCount: PositiveInteger,
      eventCount: NonNegativeInteger,
      gateCount: PositiveInteger,
    }),
    Result: InsertedRun,
    execute: (request) => sql`
      INSERT INTO evaluation_runs (
        run_id,
        protocol_hash,
        snapshot_id,
        evaluation_schema_version,
        source_revision,
        image_repository,
        image_digest,
        strategy_name,
        initial_capital_micros,
        expected_artifact_count,
        expected_event_count,
        expected_gate_count,
        status
      ) VALUES (
        ${request.runId},
        ${request.protocolHash},
        ${request.snapshotId},
        ${request.evaluationSchemaVersion},
        ${request.sourceRevision},
        ${request.imageRepository},
        ${request.imageDigest},
        ${request.strategyName},
        ${request.initialCapitalMicros},
        ${request.artifactCount},
        ${request.eventCount},
        ${request.gateCount},
        'WRITING'
      )
      ON CONFLICT (run_id) DO NOTHING
      RETURNING run_id
    `,
  })
  const completeRun = SqlSchema.findAll({
    Request: RunRequest,
    Result: InsertedRun,
    execute: ({ runId }) => sql`
      UPDATE evaluation_runs AS run
      SET status = 'COMPLETE', completed_at = transaction_timestamp()
      WHERE run.run_id = ${runId}
        AND run.status = 'WRITING'
        AND run.expected_artifact_count = (
          SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = ${runId}
        )
        AND run.expected_event_count = (
          SELECT count(*)::integer FROM evaluation_events WHERE run_id = ${runId}
        )
        AND run.expected_gate_count = (
          SELECT count(*)::integer FROM gate_outcomes WHERE run_id = ${runId}
        )
      RETURNING run.run_id
    `,
  })
  const getReceipt = SqlSchema.findAll({
    Request: RunRequest,
    Result: ReceiptRow,
    execute: ({ runId }) => sql`
      SELECT
        run.run_id,
        run.protocol_hash,
        run.snapshot_id,
        run.evaluation_schema_version,
        run.source_revision,
        run.image_repository,
        run.image_digest,
        run.strategy_name,
        run.initial_capital_micros::text AS initial_capital_micros,
        run.status,
        run.expected_artifact_count,
        run.expected_event_count,
        run.expected_gate_count,
        (SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
        (SELECT count(*)::integer FROM evaluation_events WHERE run_id = run.run_id) AS event_count,
        (SELECT count(*)::integer FROM gate_outcomes WHERE run_id = run.run_id) AS gate_count
      FROM evaluation_runs AS run
      WHERE run.run_id = ${runId}
    `,
  })
  const getArtifactReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: ArtifactReferenceRow,
    execute: ({ runId }) => sql`
      SELECT artifact_name, schema_version, content_hash, payload
      FROM evaluation_artifacts
      WHERE run_id = ${runId}
      ORDER BY artifact_name
    `,
  })
  const getArtifactSeriesMetadata = SqlSchema.findAll({
    Request: Schema.Struct({ runId: Sha256, artifactName: Schema.String }),
    Result: ArtifactSeriesMetadataRow,
    execute: ({ runId, artifactName }) => sql`
      SELECT
        artifact.schema_version,
        artifact.content_hash,
        jsonb_array_length(artifact.payload -> 'items')::integer AS item_count
      FROM evaluation_artifacts AS artifact
      JOIN evaluation_runs AS run USING (run_id)
      WHERE artifact.run_id = ${runId}
        AND artifact.artifact_name = ${artifactName}
        AND run.status = 'COMPLETE'
        AND jsonb_typeof(artifact.payload -> 'items') = 'array'
    `,
  })
  const getArtifactItems = SqlSchema.findAll({
    Request: Schema.Struct({
      runId: Sha256,
      artifactName: Schema.String,
      afterOrdinal: Schema.Int,
      limit: PositiveInteger,
    }),
    Result: ArtifactItemRow,
    execute: ({ runId, artifactName, afterOrdinal, limit }) => sql`
      SELECT (item.ordinality - 1)::integer AS ordinal, item.payload
      FROM evaluation_artifacts AS artifact
      CROSS JOIN LATERAL jsonb_array_elements(artifact.payload -> 'items')
        WITH ORDINALITY AS item(payload, ordinality)
      WHERE artifact.run_id = ${runId}
        AND artifact.artifact_name = ${artifactName}
        AND (item.ordinality - 1) > ${afterOrdinal}
      ORDER BY item.ordinality
      LIMIT ${limit}
    `,
  })
  const getEventReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: EventReferenceRow,
    execute: ({ runId }) => sql`
      SELECT ordinal, event_id, event_kind, content_hash, payload
      FROM evaluation_events
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getGateReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: GateReferenceRow,
    execute: ({ runId }) => sql`
      SELECT ordinal, gate_name, passed, actual, required, content_hash
      FROM gate_outcomes
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getStatusReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: StatusReferenceRow,
    execute: ({ runId }) => sql`
      SELECT status, detail FROM status_history WHERE run_id = ${runId} ORDER BY sequence
    `,
  })

  return {
    health,
    getProtocol,
    getSnapshot,
    insertRun,
    completeRun,
    getReceipt,
    getArtifactReferences,
    getArtifactSeriesMetadata,
    getArtifactItems,
    getEventReferences,
    getGateReferences,
    getStatusReferences,
  }
}

export type EvidenceStatements = ReturnType<typeof makeEvidenceStatements>
