import { cryptoMaximumTakerFeeBps } from '../src/broker/crypto-fees'
import { Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../src/hash'
import { PositiveMicrosSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../src/schemas'
import { cryptoTakerFeeSchedule, receivedCryptoFee } from '../src/strategy/execution-model/fees'
import { jevBreakEvenExitBid } from '../src/jev/liquidation-economics'
import type { JevProtocol } from '../src/jev/protocol'

const Coin = Schema.Struct({ kind: Schema.Literal('COIN'), quantityAtoms: PositiveMicrosSchema })
const Cash = Schema.Struct({ kind: Schema.Literal('CASH'), cashMicros: PositiveMicrosSchema })
const Debit = Schema.Union([Coin, Cash])
const Source = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.historical-matched-fees.v1'),
  provider: Schema.Literal('alpaca'),
  environment: Schema.Literal('sandbox'),
  accountId: Schema.NonEmptyString,
  effectiveAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
  rounding: Schema.Literal('OBSERVED_PROVIDER_DEBITS_NOT_INFERRED_RATES'),
  matches: Schema.Array(
    Schema.Struct({
      symbol: Schema.Literals(['BTC/USD', 'ETH/USD', 'SOL/USD']),
      side: Schema.Literals(['buy', 'sell']),
      sourceFillHash: Sha256Schema,
      providerActivityHash: Sha256Schema,
      providerAccountId: Schema.NonEmptyString,
      providerEnvironment: Schema.Literal('sandbox'),
      providerSymbol: Schema.NonEmptyString,
      providerSide: Schema.Literals(['buy', 'sell']),
      fillQuantityAtoms: PositiveMicrosSchema,
      fillNotionalMicros: PositiveMicrosSchema,
      providerDebit: Debit,
      matchedDebit: Debit,
    }),
  ).check(Schema.isMinLength(1)),
})
const Input = Schema.Struct({ source: Source, expectedSourceHash: Sha256Schema })

// Export integrity is not a provider signature or a current-tier assertion.
export const historicalFeeProvenance = (input: unknown, accountId: string, decisionAt: string) => {
  const validatedDecisionAt = Result.getOrThrow(Schema.decodeUnknownResult(UtcInstantSchema)(decisionAt))
  const { source, expectedSourceHash } = Result.getOrThrow(Schema.decodeUnknownResult(Input)(input, strictParseOptions))
  if (Result.getOrThrow(canonicalHashV1Result(source)) !== expectedSourceHash)
    throw new Error('Historical fee source hash mismatch')
  if (source.accountId !== accountId) throw new Error('Historical fee account does not match sealed decision')
  if (
    Date.parse(source.effectiveAt) > Date.parse(source.observedAt) ||
    Date.parse(source.observedAt) > Date.parse(validatedDecisionAt)
  )
    throw new Error('Fee evidence must have been observed historically before the decision')
  const seen = new Set<string>()
  const matches = source.matches.map((match) => {
    if (seen.has(`fill:${match.sourceFillHash}`) || seen.has(`fee:${match.providerActivityHash}`))
      throw new Error('Duplicate historical fee match')
    seen.add(`fill:${match.sourceFillHash}`)
    seen.add(`fee:${match.providerActivityHash}`)
    if (
      match.providerAccountId !== source.accountId ||
      match.providerEnvironment !== source.environment ||
      match.providerSymbol !== match.symbol ||
      match.providerSide !== match.side
    )
      throw new Error('Provider fee identity does not match fill identity')
    if (
      Result.getOrThrow(canonicalHashV1Result(match.providerDebit)) !==
      Result.getOrThrow(canonicalHashV1Result(match.matchedDebit))
    )
      throw new Error('Matched fee does not equal provider debit')
    const debit = match.providerDebit
    if ((match.side === 'buy') !== (debit.kind === 'COIN'))
      throw new Error('Crypto fee debit asset disagrees with trade side')
    const numerator = BigInt(debit.kind === 'COIN' ? debit.quantityAtoms : debit.cashMicros)
    const denominator = BigInt(debit.kind === 'COIN' ? match.fillQuantityAtoms : match.fillNotionalMicros)
    if (numerator > denominator) throw new Error('Fee exceeds matched fill')
    return {
      symbol: match.symbol,
      side: match.side,
      debitKind: debit.kind,
      observedDebitRatioBps: Number((numerator * 10_000_000n) / denominator) / 1000,
    }
  })
  return {
    historicalOnly: true,
    currentTier: 'UNKNOWN',
    providerAuthenticityIndependentlyVerified: false,
    declaredAccountMatchesSealedDecision: true,
    environment: source.environment,
    effectiveAt: source.effectiveAt,
    observedAt: source.observedAt,
    rounding: source.rounding,
    ratioRounding: 'TRUNCATED_TO_0.001_BPS_NOT_A_TIER',
    sourceHashIntegrityOnly: true,
    sourceHash: expectedSourceHash,
    matches,
  }
}

const Economics = Schema.Struct({
  maximumQuantityAtoms: PositiveMicrosSchema,
  receivedQuantityAtoms: PositiveMicrosSchema,
  acquisitionCostMicros: PositiveMicrosSchema,
  maximumEntryPriceMicros: PositiveMicrosSchema,
  holdingExitBreakEvenBidUsd: Schema.Finite,
})
export const hypotheticalCryptoFeeSensitivity = (input: {
  symbol: string
  protocol: JevProtocol
  economics: unknown
  bidMicros: bigint
}) => {
  if (!['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(input.symbol) || input.bidMicros <= 0n)
    throw new Error('Fee sensitivity requires a supported crypto symbol and positive bid')
  if (cryptoTakerFeeSchedule.takerBps !== 25) throw new Error('Fee sensitivity requires the configured 25bps ceiling')
  const economics = Result.getOrThrow(Schema.decodeUnknownResult(Economics)(input.economics))
  const quantity = BigInt(economics.maximumQuantityAtoms)
  const acquisition = BigInt(economics.acquisitionCostMicros)
  const scenarios = [25, 22, 20, 18].map((bps) => {
    const multiplier = BigInt(bps) * 40_000n
    const debit = receivedCryptoFee(
      { symbol: input.symbol, side: 'buy', quantityAtoms: quantity, notionalMicros: acquisition },
      multiplier,
      cryptoMaximumTakerFeeBps,
    )
    const received = quantity - debit.quantityAtoms
    if (received <= 0n) throw new Error('Fee sensitivity has no received inventory')
    const bid = Result.getOrThrow(
      jevBreakEvenExitBid({
        protocol: input.protocol,
        symbol: input.symbol,
        quantityAtoms: received,
        acquisitionCostMicros: acquisition,
        upperBidMicros: BigInt(economics.maximumEntryPriceMicros) * 2n,
        costMultiplierMicros: multiplier,
      }),
    )
    if (bps === 25) {
      const sealedBidMicros = Math.round(economics.holdingExitBreakEvenBidUsd * 1_000_000)
      if (
        received !== BigInt(economics.receivedQuantityAtoms) ||
        !Number.isSafeInteger(sealedBidMicros) ||
        !Number.isSafeInteger(Number(bid)) ||
        BigInt(sealedBidMicros) !== bid ||
        Number(bid) / 1_000_000 !== economics.holdingExitBreakEvenBidUsd
      )
        throw new Error('Fee sensitivity does not reproduce sealed 25bps baseline')
    }
    return {
      hypotheticalFeeBpsPerSide: bps,
      receivedQuantityAtoms: received.toString(),
      holdingExitBreakEvenBidMicros: bid.toString(),
      holdingExitRequiredBidRiseBps: Number(((bid - input.bidMicros) * 10_000_000n) / input.bidMicros) / 1000,
    }
  })
  return {
    hypotheticalOnly: true,
    profitableEdgeProven: false,
    liveCostAssumptionsChanged: false,
    allowancesAndAcquisitionUnchanged: true,
    baselineReproducedExactly: true,
    scenarios,
  }
}
