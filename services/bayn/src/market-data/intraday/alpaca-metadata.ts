import { Schema } from 'effect'

const TradeIdSchema = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))
const WireTradeIdSchema = Schema.Union([
  TradeIdSchema,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
])
const OptionalText = Schema.optional(Schema.NullOr(Schema.String))
const OptionalConditions = Schema.optional(Schema.NullOr(Schema.Array(Schema.String)))

export const AlpacaQuoteMetadataSchema = Schema.Struct({
  bidExchange: OptionalText,
  askExchange: OptionalText,
  conditions: OptionalConditions,
  tape: OptionalText,
})
export type AlpacaQuoteMetadata = typeof AlpacaQuoteMetadataSchema.Type

export const AlpacaTradeMetadataSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(TradeIdSchema)),
  exchange: OptionalText,
  conditions: OptionalConditions,
  tape: OptionalText,
})
export type AlpacaTradeMetadata = typeof AlpacaTradeMetadataSchema.Type

export const AlpacaQuoteWireMetadataSchema = Schema.Struct({
  bx: OptionalText,
  ax: OptionalText,
  c: OptionalConditions,
  z: OptionalText,
})
export const AlpacaTradeWireMetadataSchema = Schema.Struct({
  i: Schema.optional(Schema.NullOr(WireTradeIdSchema)),
  x: OptionalText,
  c: OptionalConditions,
  z: OptionalText,
})

export const alpacaQuoteMetadata = (
  payload: typeof AlpacaQuoteWireMetadataSchema.Type,
): AlpacaQuoteMetadata | undefined => {
  const metadata = {
    ...(payload.bx === undefined ? {} : { bidExchange: payload.bx }),
    ...(payload.ax === undefined ? {} : { askExchange: payload.ax }),
    ...(payload.c === undefined ? {} : { conditions: payload.c === null ? null : Object.freeze([...payload.c]) }),
    ...(payload.z === undefined ? {} : { tape: payload.z }),
  }
  return Object.keys(metadata).length === 0 ? undefined : Object.freeze(metadata)
}

export const alpacaTradeMetadata = (
  payload: typeof AlpacaTradeWireMetadataSchema.Type,
): AlpacaTradeMetadata | undefined => {
  const metadata = {
    ...(payload.i === undefined ? {} : { id: payload.i === null ? null : String(payload.i) }),
    ...(payload.x === undefined ? {} : { exchange: payload.x }),
    ...(payload.c === undefined ? {} : { conditions: payload.c === null ? null : Object.freeze([...payload.c]) }),
    ...(payload.z === undefined ? {} : { tape: payload.z }),
  }
  return Object.keys(metadata).length === 0 ? undefined : Object.freeze(metadata)
}
