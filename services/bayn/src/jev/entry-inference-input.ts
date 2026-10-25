import { Result, Schema } from 'effect'

import { CryptoFeeTierSchema } from '../broker/crypto-fees'
import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import { SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { ChartSourceSchema, decodeChartSource } from './chart-evidence'
import { JevContractError } from './contract'
import { JevProtocolSchema } from './protocol'

const Price = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))
export const EntryInferenceInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.entry-inference-input.v1'),
  numericalState: Schema.Record(Schema.String, Schema.Json),
  chartSource: ChartSourceSchema,
  protocol: JevProtocolSchema,
  funding: Schema.Struct({
    bidMicros: Price,
    askMicros: Price,
    capitalMicros: Price,
    cryptoFeeTier: Schema.NullOr(CryptoFeeTierSchema),
  }),
})
export type EntryInferenceInput = typeof EntryInferenceInputSchema.Type

export const prepareEntryInferenceInput = (input: unknown) =>
  Result.gen(function* () {
    const value = yield* Schema.decodeUnknownResult(EntryInferenceInputSchema, strictParseOptions)(input)
    yield* Schema.decodeUnknownResult(
      Schema.Struct({
        schemaVersion: Schema.Literal('bayn.jev-entry-state.v22'),
        task: Schema.Struct({ decisionPurpose: Schema.Literal('ENTRY') }),
      }),
    )(value.numericalState)
    const source = yield* decodeChartSource(value.chartSource)
    const candidate = yield* Schema.decodeUnknownResult(
      Schema.Struct({ symbol: SymbolSchema, bars1m: ChartSourceSchema.fields.bars }),
    )(value.numericalState['candidate'])
    const session = yield* Schema.decodeUnknownResult(Schema.Struct({ completedBarWindowEndsAt: UtcInstantSchema }))(
      value.numericalState['session'],
    )
    if (
      candidate.symbol !== source.symbol ||
      session.completedBarWindowEndsAt !== source.windowEndAt ||
      !value.protocol.candidateSymbols.includes(source.symbol) ||
      BigInt(value.funding.bidMicros) > BigInt(value.funding.askMicros)
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Entry inference source, symbol, funding quote or native protocol differ' }),
      )
    const barsHash = yield* canonicalHashV1Result(source.bars)
    if ((yield* canonicalHashV1Result(candidate.bars1m)) !== barsHash)
      return yield* Result.fail(
        new JevContractError({ message: 'Chart and numerical evidence must contain the same source bars' }),
      )
    const body = yield* canonicalJsonV1Result(value)
    if (Buffer.byteLength(body) > 128_000)
      return yield* Result.fail(
        new JevContractError({ message: 'Entry inference input exceeds the native transport budget' }),
      )
    const detached = yield* Schema.decodeUnknownResult(Schema.fromJsonString(EntryInferenceInputSchema))(body)
    return { input: detached, body, requestHash: yield* canonicalHashV1Result(detached) }
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Entry inference input violates its source-bound contract', cause }),
    ),
  )
