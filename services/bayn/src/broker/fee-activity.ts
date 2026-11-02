import { Schema } from 'effect'
import { PositiveMicrosSchema } from '../execution/contracts'
import { SymbolSchema, IsoDateSchema, StrictNonEmptyStringSchema, UtcOrderTimestampSchema } from '../schemas'

export const FeeActivitySchema = Schema.Struct({
  accountId: StrictNonEmptyStringSchema,
  activityId: StrictNonEmptyStringSchema,
  date: IsoDateSchema,
  cryptoCashFee: Schema.optionalKey(Schema.Literal(true)),
  coinDebit: Schema.optionalKey(
    Schema.Struct({ symbol: SymbolSchema, quantityAtoms: PositiveMicrosSchema, priceAtoms: PositiveMicrosSchema }),
  ),
  netAmountMicros: Schema.String.check(Schema.isPattern(/^(?:0|-?[1-9][0-9]*)$/)),
}).check(
  Schema.makeFilter(
    (fee) => fee.cryptoCashFee !== true || (fee.coinDebit === undefined && BigInt(fee.netAmountMicros) < 0n),
  ),
)

export const ObservedFeeActivitySchema = Schema.Struct({
  ...FeeActivitySchema.fields,
  sourceCreatedAt: Schema.optionalKey(UtcOrderTimestampSchema),
}).check(
  Schema.makeFilter(
    (fee) =>
      (fee.cryptoCashFee !== true || (fee.coinDebit === undefined && BigInt(fee.netAmountMicros) < 0n)) &&
      (fee.sourceCreatedAt === undefined || fee.cryptoCashFee === true || fee.coinDebit !== undefined),
  ),
)
