import { Data, Result, Schema } from 'effect'

import { CycleState } from '../cycle/model'
import { canonicalHashV1Result } from '../hash'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { JevPurpose } from './portfolio'

export const JevStudyCycleSchema = Schema.Struct({
  cycleId: Sha256Schema,
  protocolHash: Sha256Schema,
  state: Schema.Enum(CycleState),
  decisionHash: Schema.NullOr(Sha256Schema),
})

const ReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-study-export.v1'),
  accountBindingHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  asOf: UtcInstantSchema,
  cycleCount: NonNegativeIntegerSchema,
  batchCount: NonNegativeIntegerSchema,
  entryBatchCount: NonNegativeIntegerSchema,
  managementBatchCount: NonNegativeIntegerSchema,
  pendingResultCount: NonNegativeIntegerSchema,
  sourceCoverage: Schema.Literal('RECORDED_OBSERVATIONS_ONLY'),
  qualification: Schema.Literal('UNQUALIFIED'),
  controllerCoverage: Schema.Literal('UNKNOWN'),
  bytes: PositiveIntegerSchema,
  dataSha256: Sha256Schema,
  receiptHash: Sha256Schema,
})

export const JevStudyInventorySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-study-inventory.v1'),
  receipt: ReceiptSchema,
  cycles: Schema.Array(JevStudyCycleSchema),
  batches: Schema.Array(
    Schema.Struct({
      batchId: Sha256Schema,
      cycleId: Sha256Schema,
      observationHash: Sha256Schema,
      purpose: Schema.Enum(JevPurpose),
      resultHash: Schema.NullOr(Sha256Schema),
    }),
  ),
})
export type JevStudyInventory = typeof JevStudyInventorySchema.Type

export class JevStudyInventoryFailure extends Data.TaggedError('JevStudyInventoryFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A pinned file must identify the complete native export cut, not just repeat an inline list of selected entries. */
export const verifyJevStudyInventory = (input: unknown) =>
  Result.gen(function* () {
    const inventory = yield* Schema.decodeUnknownResult(JevStudyInventorySchema, strictParseOptions)(input)
    const { receipt, cycles, batches } = inventory
    const { receiptHash, ...material } = receipt
    if ((yield* canonicalHashV1Result(material)) !== receiptHash)
      return yield* Result.fail(new JevStudyInventoryFailure({ message: 'Inventory export receipt identity differs' }))
    const cycleIds = new Set(cycles.map((cycle) => cycle.cycleId))
    if (
      cycles.some((cycle, index) => index > 0 && (cycles[index - 1]?.cycleId ?? '') >= cycle.cycleId) ||
      batches.some(
        (batch, index) =>
          !cycleIds.has(batch.cycleId) || (index > 0 && (batches[index - 1]?.batchId ?? '') >= batch.batchId),
      )
    )
      return yield* Result.fail(
        new JevStudyInventoryFailure({
          message: 'Inventory identities are duplicated, unordered or outside its cycles',
        }),
      )
    const entries = batches.filter((batch) => batch.purpose === JevPurpose.Entry)
    if (
      receipt.cycleCount !== cycles.length ||
      receipt.batchCount !== batches.length ||
      receipt.entryBatchCount !== entries.length ||
      receipt.managementBatchCount !== batches.length - entries.length ||
      receipt.pendingResultCount !== batches.filter((batch) => batch.resultHash === null).length
    )
      return yield* Result.fail(
        new JevStudyInventoryFailure({ message: 'Inventory differs from its export counts or pending results' }),
      )
    return inventory
  }).pipe(
    Result.mapError((cause) => new JevStudyInventoryFailure({ message: 'Invalid native study inventory', cause })),
  )
