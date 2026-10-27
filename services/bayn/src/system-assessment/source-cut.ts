import { AccountMarkSchema } from './valuation'
import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import { InferenceCostEvidenceSchema } from '../inference-costs'
import { ExecutionDecisionDocumentSchema } from '../shadow-decision-contract'
import { IsoDateSchema, Sha256Schema, UnsignedMicrosSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { OrderStatus } from '../execution/contracts'
import { MutationEventSchema } from '../execution/mutations/model'
import { CapturedFinancialEvidenceSchema } from './forward-evidence'
import { SystemAssessmentError } from './economics'
import { ControllerPassEvidenceSchema } from './decision-work'
import { JevBatchPlanSchema, JevBatchResultSchema } from '../jev/batch'
import { JevObservationSchema } from '../jev/observation-contract'

export const SystemSourceCutSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.system-source-cut.v2'),
  registrationHash: Sha256Schema,
  asOf: UtcInstantSchema,
  runtimeConfigurationHash: Sha256Schema,
  financial: Schema.Array(CapturedFinancialEvidenceSchema).check(Schema.isMaxLength(4)),
  inference: Schema.Array(InferenceCostEvidenceSchema),
  inferenceLedgerEvidenceHash: Sha256Schema,
  decisions: Schema.Array(Schema.Struct({ sessionDate: IsoDateSchema, document: ExecutionDecisionDocumentSchema })),
  batches: Schema.Array(
    Schema.Struct({
      plan: JevBatchPlanSchema,
      observation: Schema.NullOr(JevObservationSchema),
      result: Schema.NullOr(JevBatchResultSchema),
    }),
  ),
  mutations: Schema.Array(
    Schema.Struct({
      authorityGenerationHash: Sha256Schema,
      strategyDecisionHash: Sha256Schema,
      event: MutationEventSchema,
    }),
  ),
  fills: Schema.Array(
    Schema.Struct({
      fillId: Sha256Schema,
      intentId: Sha256Schema,
      decisionId: Sha256Schema,
      sourceHash: Sha256Schema,
      side: Schema.Literals(['BUY', 'SELL']),
      quantityAtoms: UnsignedMicrosSchema,
      priceAtoms: UnsignedMicrosSchema,
      occurredAt: UtcInstantSchema,
    }),
  ),
  orders: Schema.Array(
    Schema.Struct({
      intentId: Sha256Schema,
      decisionId: Sha256Schema,
      authorityGenerationHash: Sha256Schema,
      sourceHash: Sha256Schema,
      side: Schema.Literals(['BUY', 'SELL']),
      quantityAtoms: Schema.NullOr(UnsignedMicrosSchema),
      filledQuantityAtoms: UnsignedMicrosSchema,
      status: Schema.Enum(OrderStatus),
      occurredAt: UtcInstantSchema,
      observedAt: UtcInstantSchema,
    }),
  ),
  accountMarks: Schema.Array(AccountMarkSchema),
  controllerPasses: Schema.Array(ControllerPassEvidenceSchema),
  durableObservations: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(['DECISION', 'RECONCILIATION', 'MUTATION', 'CONTROLLER', 'BATCH']),
      sourceHash: Sha256Schema,
      sourceAt: UtcInstantSchema,
      witnessedAt: UtcInstantSchema,
      correct: Schema.Boolean,
    }),
  ),
  sourceMaterial: Schema.Unknown,
  sourceMaterialHash: Sha256Schema,
})

export type SystemSourceCut = typeof SystemSourceCutSchema.Type

export const persistSystemSourceCut = (input: unknown) =>
  Effect.gen(function* () {
    const cut = yield* Schema.decodeUnknownEffect(SystemSourceCutSchema, strictParseOptions)(input)
    if ((yield* Effect.fromResult(canonicalHashV1Result(cut.sourceMaterial))) !== cut.sourceMaterialHash)
      return yield* new SystemAssessmentError({ message: 'Source cut material digest differs' })
    const sourceCutHash = yield* Effect.fromResult(canonicalHashV1Result(cut))
    const payload = yield* Effect.fromResult(canonicalJsonV1Result(cut))
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO system_evidence_cuts(source_cut_hash, registration_hash, as_of, payload_text)
    VALUES (${sourceCutHash}, ${cut.registrationHash}, ${cut.asOf}, ${payload}) ON CONFLICT (source_cut_hash) DO NOTHING`
    return { sourceCutHash, cut }
  }).pipe(
    Effect.mapError((cause) => new SystemAssessmentError({ message: 'System source cut persistence failed', cause })),
  )

export const readSystemSourceCut = (hash: string) =>
  Effect.gen(function* () {
    const sourceCutHash = yield* Schema.decodeUnknownEffect(Sha256Schema)(hash)
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ payload: SystemSourceCutSchema })))(
      yield* sql`SELECT payload_text::jsonb AS payload FROM system_evidence_cuts WHERE source_cut_hash = ${sourceCutHash}`,
    )
    const cut = rows[0]?.payload
    if (cut === undefined || (yield* Effect.fromResult(canonicalHashV1Result(cut))) !== sourceCutHash)
      return yield* new SystemAssessmentError({ message: 'Immutable source cut is missing or its digest differs' })
    return cut
  }).pipe(Effect.mapError((cause) => new SystemAssessmentError({ message: 'System source cut read failed', cause })))
