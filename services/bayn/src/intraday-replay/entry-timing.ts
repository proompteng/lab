import { Schema } from 'effect'
import { Sha256Schema, SourceRevisionSchema, SymbolSchema, UtcInstantSchema } from '../schemas'
import { nativeWallClock } from '../time'

const EntryReadinessTimingSchema = Schema.Struct({
  batchId: Sha256Schema,
  observationHash: Sha256Schema,
  snapshotHash: Sha256Schema,
  inputAvailableAt: UtcInstantSchema,
  deterministicSelectedAt: UtcInstantSchema,
  deterministicSymbol: Schema.NullOr(SymbolSchema),
  batchCompletedAt: UtcInstantSchema,
})

export const EntryTimingReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-entry-timing.v2'),
  clock: Schema.Literal(nativeWallClock),
  sourceRevision: SourceRevisionSchema,
  ...EntryReadinessTimingSchema.fields,
  decisionHash: Sha256Schema,
  decisionCommittedAt: UtcInstantSchema,
})
