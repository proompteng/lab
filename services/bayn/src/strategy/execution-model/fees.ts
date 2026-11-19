import { Result, Schema, pipe } from 'effect'
import type { CryptoTakerFeeBps } from '../../broker/crypto-fees'

import { instrumentMarket, MarketKind } from '../../instruments'
import type { ExecutionModel } from '../../execution-model-contract'
import { ceilDiv, ensureUnsigned, fail, scaledNumber, type ExecutionResult } from './fixed-point'
import { quantityScale } from '../../quantity'
import { BPS, MICROS } from './model'
import { IsoDateSchema, UtcInstantSchema } from '../../schemas'

export interface FeeInput {
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly quantityAtoms: bigint
  readonly notionalMicros: bigint
}

export interface FeeBreakdown {
  readonly commissionMicros: bigint
  readonly secMicros: bigint
  readonly tafMicros: bigint
  readonly catMicros: bigint
  readonly cryptoMicros: bigint
  readonly cashMicros: bigint
  readonly totalMicros: bigint
}

const roundedFee = (numerator: bigint, denominator: bigint, increment: bigint): ExecutionResult<bigint> =>
  numerator === 0n
    ? Result.succeed(0n)
    : pipe(
        ceilDiv(numerator, denominator * increment),
        Result.map((quotient) => quotient * increment),
      )

const feeDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
const isIsoDate = Schema.is(IsoDateSchema)
const isUtcInstant = Schema.is(UtcInstantSchema)

export const equityTafRate = (model: Pick<ExecutionModel, 'fees'>, at: string): ExecutionResult<bigint> => {
  if (model.fees.scheduleVersion === 'alpaca-brokerage-2026-07-01')
    return ensureUnsigned(model.fees.tafSellPerShareMicros, 'retained TAF share rate')
  const parsed = Date.parse(at)
  if (!isIsoDate(at) && !isUtcInstant(at)) return fail({ _tag: 'UnsupportedEquityFeeDate', at })
  const date = /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : feeDate.format(parsed)
  // Alpaca's October 12 disclosure and SEC release 34-106409. Later schedules require new evidence.
  if (date < '2026-07-01' || date >= '2029-01-01') return fail({ _tag: 'UnsupportedEquityFeeDate', at })
  return date >= '2026-10-01' && date < '2027-01-01'
    ? Result.succeed(0n)
    : ensureUnsigned(model.fees.tafSellPerShareMicros, 'TAF share rate')
}

export const cryptoTakerFeeSchedule = Object.freeze({
  schemaVersion: 'bayn.crypto-taker-fees.v1',
  source: 'https://docs.alpaca.markets/us/docs/crypto-trading',
  verifiedAt: '2026-10-15',
  tier: '0-100000-USD-trailing-30-days',
  takerBps: 25,
  quantityRoundingAtoms: '1',
  cashRoundingMicros: '10000',
  rounding: 'conservative-ceiling-research-assumption',
  buyDebit: 'received-base-asset',
  sellDebit: 'received-USD',
} as const)

export const receivedCryptoFee = (fill: FeeInput, multiplier: bigint, takerFeeBps: CryptoTakerFeeBps) => {
  if (instrumentMarket(fill.symbol) !== MarketKind.Crypto) return { quantityAtoms: 0n, valueMicros: 0n, cashMicros: 0n }
  const denominator = BPS * MICROS
  const rate = BigInt(takerFeeBps) * multiplier
  if (fill.side === 'sell') {
    const increment = BigInt(cryptoTakerFeeSchedule.cashRoundingMicros)
    const cashMicros =
      ((fill.notionalMicros * rate + denominator * increment - 1n) / (denominator * increment)) * increment
    return { quantityAtoms: 0n, valueMicros: cashMicros, cashMicros }
  }
  const quantityAtoms = (fill.quantityAtoms * rate + denominator - 1n) / denominator
  const valueMicros =
    fill.quantityAtoms === 0n
      ? 0n
      : (fill.notionalMicros * quantityAtoms + fill.quantityAtoms - 1n) / fill.quantityAtoms
  return { quantityAtoms, valueMicros, cashMicros: 0n }
}

export const calculateSessionFees = (
  fills: readonly FeeInput[],
  model: Pick<ExecutionModel, 'fees'>,
  costMultiplierMicros: bigint,
  takerFeeBps: CryptoTakerFeeBps,
  at: string,
): ExecutionResult<FeeBreakdown> => {
  if (costMultiplierMicros <= 0n) {
    return fail({ _tag: 'InvalidFeeCostMultiplier', costMultiplierMicros, minimum: 1n })
  }
  let cryptoMicros = 0n
  let cryptoCashMicros = 0n
  let totalNotional = 0n
  let sellNotional = 0n
  let totalQuantity = 0n
  const equityFills: FeeInput[] = []
  for (const fill of fills) {
    if (instrumentMarket(fill.symbol) === MarketKind.Equity) {
      equityFills.push(fill)
      totalNotional += fill.notionalMicros
      totalQuantity += fill.quantityAtoms
      if (fill.side === 'sell') sellNotional += fill.notionalMicros
    } else {
      const fee = receivedCryptoFee(fill, costMultiplierMicros, takerFeeBps)
      cryptoMicros += fee.valueMicros
      cryptoCashMicros += fee.cashMicros
    }
  }

  return pipe(
    Result.all({
      rounding: ensureUnsigned(model.fees.roundingIncrementMicros, 'fee rounding increment', 1n),
      commissionRate: scaledNumber(model.fees.commissionBps, 'commission basis points'),
      secRate: scaledNumber(model.fees.secSellBps, 'SEC basis points'),
      tafRate: equityFills.length === 0 ? Result.succeed(0n) : equityTafRate(model, at),
      tafCap: ensureUnsigned(model.fees.tafMaximumPerOrderMicros, 'TAF order cap'),
      catRate: ensureUnsigned(model.fees.catPerShareMicros, 'CAT share rate'),
    }),
    Result.flatMap(({ rounding, commissionRate, secRate, tafRate, tafCap, catRate }) => {
      const tafNumerator = equityFills.reduce(
        (sum, fill) =>
          fill.side === 'sell'
            ? sum +
              (fill.quantityAtoms * tafRate < tafCap * quantityScale
                ? fill.quantityAtoms * tafRate
                : tafCap * quantityScale)
            : sum,
        0n,
      )
      return pipe(
        Result.all({
          commission: roundedFee(
            totalNotional * commissionRate * costMultiplierMicros,
            BPS * MICROS * MICROS,
            rounding,
          ),
          sec: roundedFee(sellNotional * secRate * costMultiplierMicros, BPS * MICROS * MICROS, rounding),
          taf: roundedFee(tafNumerator * costMultiplierMicros, quantityScale * MICROS, rounding),
          cat: roundedFee(totalQuantity * catRate * costMultiplierMicros, quantityScale * MICROS, rounding),
        }),
        Result.map(
          ({ commission, sec, taf, cat }): FeeBreakdown => ({
            commissionMicros: commission,
            secMicros: sec,
            tafMicros: taf,
            catMicros: cat,
            cryptoMicros,
            cashMicros: commission + sec + taf + cat + cryptoCashMicros,
            totalMicros: commission + sec + taf + cat + cryptoMicros,
          }),
        ),
      )
    }),
  )
}
