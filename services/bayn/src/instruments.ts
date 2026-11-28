import { Data, Result, Schema } from 'effect'

import { quantityFromDecimal, quantityScale } from './quantity'

export enum MarketKind {
  Equity = 'EQUITY',
  Crypto = 'CRYPTO',
}

export const InstrumentSymbolSchema = Schema.String.check(
  Schema.isPattern(/^(?!(?:BTCUSD|ETHUSD|SOLUSD)$)(?:[A-Z][A-Z0-9.-]{0,15}|(?:BTC|ETH|SOL)\/USD)$/),
)

export interface Instrument {
  readonly symbol: string
  readonly market: MarketKind
  readonly minimumQuantityAtoms: bigint
  readonly quantityIncrementAtoms: bigint
  readonly priceIncrementAtoms: bigint
}

export class InstrumentError extends Data.TaggedError('InstrumentError')<{
  readonly symbol: string
  readonly message: string
}> {}

export const instrumentMarket = (symbol: string): MarketKind =>
  symbol.includes('/') ? MarketKind.Crypto : MarketKind.Equity

export const decodeInstrument = (input: {
  readonly symbol: string
  readonly assetClass: 'us_equity' | 'crypto'
  readonly minimumOrderSize: string | null
  readonly quantityIncrement: string | null
  readonly priceIncrement: string | null
}): Result.Result<Instrument, InstrumentError> =>
  Result.gen(function* () {
    const market = instrumentMarket(input.symbol)
    const invalid = (message: string) => Result.fail(new InstrumentError({ symbol: input.symbol, message }))
    if (
      !Schema.is(InstrumentSymbolSchema)(input.symbol) ||
      (market === MarketKind.Crypto) !== (input.assetClass === 'crypto')
    )
      return yield* invalid('instrument symbol and asset class must agree')
    if (
      market === MarketKind.Crypto &&
      (input.minimumOrderSize === null || input.quantityIncrement === null || input.priceIncrement === null)
    )
      return yield* invalid('crypto instruments require broker precision and minimum order metadata')
    const parse = (value: string) =>
      quantityFromDecimal(value).pipe(
        Result.mapError(
          () => new InstrumentError({ symbol: input.symbol, message: 'invalid instrument decimal precision' }),
        ),
      )
    const minimumQuantityAtoms = yield* parse(input.minimumOrderSize ?? '1')
    const quantityIncrementAtoms = yield* parse(input.quantityIncrement ?? '1')
    const priceIncrementAtoms = yield* parse(input.priceIncrement ?? '0.0001')
    if (
      minimumQuantityAtoms <= 0n ||
      quantityIncrementAtoms <= 0n ||
      priceIncrementAtoms <= 0n ||
      quantityIncrementAtoms > quantityScale
    )
      return yield* invalid('instrument precision and minimum quantities must be positive and representable')
    return { symbol: input.symbol, market, minimumQuantityAtoms, quantityIncrementAtoms, priceIncrementAtoms }
  })

export const instrumentQuantityTerms = (instrument: Instrument, fractionable: boolean) =>
  instrument.market === MarketKind.Equity && fractionable
    ? { minimumQuantityAtoms: 1n, quantityIncrementAtoms: 1n }
    : {
        minimumQuantityAtoms: instrument.minimumQuantityAtoms,
        quantityIncrementAtoms: instrument.quantityIncrementAtoms,
      }

export const validateInstrumentOrder = (
  instrument: Instrument,
  order: {
    readonly symbol: string
    readonly side: string
    readonly quantityAtoms: string
    readonly orderType: string
    readonly timeInForce: string
  },
  terms: {
    readonly closeOnly: boolean
    readonly fractionable: boolean
    readonly limitPriceAtoms?: bigint
    readonly stopPriceAtoms?: bigint
  },
): Result.Result<void, InstrumentError> => {
  const invalid = (message: string) => Result.fail(new InstrumentError({ symbol: order.symbol, message }))
  if (instrument.symbol !== order.symbol) return invalid('broker instrument differs from the order symbol')
  const quantity = BigInt(order.quantityAtoms)
  const quantityTerms = instrumentQuantityTerms(instrument, terms.fractionable)
  const increment = quantityTerms.quantityIncrementAtoms
  if (
    quantity <= 0n ||
    quantity % increment !== 0n ||
    (!terms.closeOnly && quantity < quantityTerms.minimumQuantityAtoms)
  )
    return invalid('order quantity violates broker minimum or increment')
  const protectiveStop =
    instrument.market === MarketKind.Crypto &&
    terms.closeOnly &&
    order.side === 'SELL' &&
    order.orderType === 'STOP_LIMIT' &&
    order.timeInForce === 'GTC'
  const validOrder =
    protectiveStop ||
    (order.orderType === 'LIMIT' && order.timeInForce === (instrument.market === MarketKind.Crypto ? 'IOC' : 'DAY'))
  if (!validOrder) return invalid('order type and duration are unsupported for this instrument')
  if (
    terms.limitPriceAtoms === undefined ||
    terms.limitPriceAtoms <= 0n ||
    terms.limitPriceAtoms % instrument.priceIncrementAtoms !== 0n
  )
    return invalid('order price violates the broker increment')
  if (
    protectiveStop &&
    (terms.stopPriceAtoms === undefined ||
      terms.stopPriceAtoms <= 0n ||
      terms.stopPriceAtoms % instrument.priceIncrementAtoms !== 0n ||
      terms.limitPriceAtoms > terms.stopPriceAtoms)
  )
    return invalid('protective stop requires a broker-aligned stop at or above its sell limit')
  if (!protectiveStop && terms.stopPriceAtoms !== undefined)
    return invalid('ordinary limit orders cannot carry a standalone stop price')
  return Result.succeed(undefined)
}
