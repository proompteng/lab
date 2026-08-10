import { PgClient } from '@effect/sql-pg'
import { Effect, Option, Schema } from 'effect'

import {
  databaseError,
  ensure,
  persistencePlanDatabaseError,
  qualificationDecisionDatabaseError,
  runDatabase,
  storedQualificationDatabaseError,
} from './errors'
import type { EvidenceStatements } from './evidence-statements'
import type { EvidenceStoreService } from './model'
import { makePersistencePlan } from './persistence-plan'
import { decodeQualificationRows, validateQualificationLockMatch } from './qualification'
import type { QualificationStatements } from './qualification-statements'
import type { EvidenceReferencePrograms } from './reference-programs'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

export const makeEvidencePersistenceProgram = (
  sql: PgClient.PgClient,
  statements: EvidenceStatements,
  qualificationStatements: QualificationStatements,
  references: EvidenceReferencePrograms,
): EvidenceStoreService['persist'] => {
  const jsonScalar = (value: number | boolean | string) => sql.json(encodeJson(value))

  return (input) =>
    runDatabase(
      'persist',
      Effect.gen(function* () {
        const plan = yield* Effect.fromResult(makePersistencePlan(input)).pipe(
          Effect.mapError((failure) => persistencePlanDatabaseError('plan', failure)),
        )

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const qualificationRows = yield* qualificationStatements.getQualificationByCandidate({
              candidateRunId: plan.evaluation.runId,
            })
            const storedQualification = yield* Effect.fromResult(decodeQualificationRows(qualificationRows)).pipe(
              Effect.mapError((failure) => storedQualificationDatabaseError('persist-qualification', failure)),
            )
            if (plan.qualification !== undefined) {
              if (Option.isNone(storedQualification)) {
                return yield* databaseError('invariant', 'persist-qualification', 'qualification lock was not opened')
              }
              yield* ensure(
                storedQualification.value.state === 'OPENED_INCOMPLETE',
                'persist-qualification',
                'qualification lock is already terminal',
              )
              yield* Effect.fromResult(
                validateQualificationLockMatch(storedQualification.value.lock, plan.qualification.lock),
              ).pipe(Effect.mapError((failure) => qualificationDecisionDatabaseError('persist-qualification', failure)))
            } else {
              yield* ensure(
                Option.isNone(storedQualification),
                'persist-qualification',
                'locked qualification candidate requires its terminal result in the same transaction',
              )
            }

            yield* references.ensureProtocolReference({
              protocolHash: plan.protocolHash,
              provenance: plan.provenance,
              parameters: plan.parameters,
            })
            yield* references.ensureSnapshotReference(plan.evaluation.inputManifest)

            const inserted = yield* statements.insertRun({
              runId: plan.evaluation.runId,
              protocolHash: plan.protocolHash,
              snapshotId: plan.snapshotId,
              evaluationSchemaVersion: plan.evaluation.schemaVersion,
              sourceRevision: plan.provenance.sourceRevision,
              imageRepository: plan.provenance.image.repository,
              imageDigest: plan.provenance.image.digest,
              strategyName: plan.strategyName,
              initialCapitalMicros: plan.evaluation.initialCapitalMicros,
              artifactCount: plan.artifacts.length,
              eventCount: plan.events.length,
              gateCount: plan.gates.length,
            })
            if (inserted.length === 0) {
              if (plan.qualification !== undefined) {
                return yield* databaseError(
                  'invariant',
                  'persist-qualification',
                  'locked qualification candidate was already evaluated without a terminal result',
                )
              }
              return yield* references.readReceipt(plan, true)
            }

            yield* sql`
              INSERT INTO status_history (run_id, status, detail)
              VALUES (
                ${plan.evaluation.runId},
                'WRITING',
                ${sql.json({
                  artifactCount: plan.artifacts.length,
                  eventCount: plan.events.length,
                  gateCount: plan.gates.length,
                })}
              )
            `
            yield* Effect.forEach(
              plan.artifacts,
              (artifact) => sql`
                INSERT INTO evaluation_artifacts (
                  run_id,
                  artifact_name,
                  schema_version,
                  content_hash,
                  payload
                ) VALUES (
                  ${plan.evaluation.runId},
                  ${artifact.name},
                  ${artifact.schemaVersion},
                  ${artifact.contentHash},
                  ${sql.json(artifact.payload)}
                )
              `,
              { discard: true },
            )
            yield* Effect.forEach(
              plan.events,
              (event) => sql`
                INSERT INTO evaluation_events (
                  run_id,
                  ordinal,
                  event_id,
                  event_kind,
                  content_hash,
                  payload
                ) VALUES (
                  ${plan.evaluation.runId},
                  ${event.ordinal},
                  ${event.id},
                  ${event.kind},
                  ${event.contentHash},
                  ${sql.json(event.payload)}
                )
              `,
              { discard: true },
            )
            yield* Effect.forEach(
              plan.gates,
              (gate) => sql`
                INSERT INTO gate_outcomes (
                  run_id,
                  ordinal,
                  gate_name,
                  passed,
                  actual,
                  required,
                  content_hash
                ) VALUES (
                  ${plan.evaluation.runId},
                  ${gate.ordinal},
                  ${gate.name},
                  ${gate.passed},
                  ${jsonScalar(gate.actual)},
                  ${jsonScalar(gate.required)},
                  ${gate.contentHash}
                )
              `,
              { discard: true },
            )

            const completed = yield* statements.completeRun({ runId: plan.evaluation.runId })
            yield* ensure(
              completed.length === 1,
              'complete-run',
              'run could not be completed with exact evidence counts',
            )
            yield* sql`
              INSERT INTO status_history (run_id, status, detail)
              VALUES (
                ${plan.evaluation.runId},
                'COMPLETE',
                ${sql.json({ reconciliationExact: true, verdict: plan.evaluation.verdict.status })}
              )
            `

            if (plan.qualification !== undefined) {
              const result = plan.qualification.result
              const resultRows = yield* qualificationStatements.insertQualificationResult({
                lockId: result.lockId,
                schemaVersion: result.schemaVersion,
                runId: result.runId,
                verdict: result.verdict,
                analysisHash: result.analysis.analysisHash,
                resultHash: result.resultHash,
                payload: result,
              })
              yield* ensure(
                resultRows.length === 1 && resultRows[0]?.lock_id === result.lockId,
                'persist-qualification',
                'terminal qualification result was not inserted exactly once',
              )
            }
            return yield* references.readReceipt(plan, false)
          }),
        )
      }),
    )
}
