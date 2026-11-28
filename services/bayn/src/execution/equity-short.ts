import { Effect, Schema } from 'effect'

import { BrokerRead, AccountStatus as BrokerAccountStatus, AssetClass, AssetStatus } from '../broker/alpaca/model'
import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, SymbolSchema, UtcInstantSchema } from '../schemas'

export const EquityShortEligibilitySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.equity-short-eligibility.v1'),
  accountId: Schema.NonEmptyString,
  symbol: SymbolSchema,
  accountHash: Sha256Schema,
  configurationHash: Sha256Schema,
  assetHash: Sha256Schema,
  accountObservedAt: UtcInstantSchema,
  configurationObservedAt: UtcInstantSchema,
  assetObservedAt: UtcInstantSchema,
  accountActive: Schema.Boolean,
  shortingEnabled: Schema.NullOr(Schema.Boolean),
  noShorting: Schema.NullOr(Schema.Boolean),
  assetActive: Schema.Boolean,
  tradable: Schema.Boolean,
  marginable: Schema.NullOr(Schema.Boolean),
  shortable: Schema.NullOr(Schema.Boolean),
  easyToBorrow: Schema.NullOr(Schema.Boolean),
})
export type EquityShortEligibility = typeof EquityShortEligibilitySchema.Type

export const equityShortIsEligible = (
  observation: EquityShortEligibility | undefined,
  accountId: string,
  symbol: string,
  at: string,
  maximumAgeMs = 15_000,
): boolean => {
  if (observation === undefined || observation.accountId !== accountId || observation.symbol !== symbol) return false
  const now = Date.parse(at)
  return (
    observation.accountActive &&
    observation.shortingEnabled === true &&
    observation.noShorting === false &&
    observation.assetActive &&
    observation.tradable &&
    observation.marginable === true &&
    observation.shortable === true &&
    observation.easyToBorrow === true &&
    [observation.accountObservedAt, observation.configurationObservedAt, observation.assetObservedAt].every((value) => {
      const age = now - Date.parse(value)
      return age >= 0 && age < maximumAgeMs
    })
  )
}

/** Fresh broker reads; never reuse a historical asset observation as a locate or future borrow guarantee. */
export const readEquityShortEligibility = (symbols: readonly string[]) =>
  Effect.gen(function* () {
    const read = yield* BrokerRead
    const fresh = read.projection?.fresh ?? read
    const common = yield* Effect.all(
      { account: fresh.account, configuration: fresh.accountConfiguration },
      { concurrency: 2 },
    )
    const assets = yield* Effect.forEach(symbols, (symbol) => fresh.assetBySymbol(symbol), { concurrency: 4 })
    const accountHash = yield* Effect.fromResult(canonicalHashV1Result(common.account.value))
    return Object.fromEntries(
      yield* Effect.forEach(assets, (asset) =>
        Effect.gen(function* () {
          const a = asset.value
          const eligibility = yield* Effect.fromResult(
            Schema.decodeUnknownResult(EquityShortEligibilitySchema)({
              schemaVersion: 'bayn.equity-short-eligibility.v1',
              accountId: common.account.value.id,
              symbol: a.symbol,
              accountHash,
              configurationHash: common.configuration.value.normalizedResponseHash,
              assetHash: a.normalizedResponseHash,
              accountObservedAt: common.account.value.observedAt,
              configurationObservedAt: common.configuration.value.observedAt,
              assetObservedAt: a.observedAt,
              accountActive:
                common.account.value.status === BrokerAccountStatus.Active &&
                !common.account.value.accountBlocked &&
                !common.account.value.tradingBlocked &&
                !common.account.value.tradeSuspendedByUser,
              shortingEnabled: common.account.value.shortingEnabled ?? null,
              noShorting: common.configuration.value.noShorting ?? null,
              assetActive: a.status === AssetStatus.Active && a.assetClass === AssetClass.UsEquity,
              tradable: a.tradable,
              marginable: a.equityShort?.marginable ?? null,
              shortable: a.equityShort?.shortable ?? null,
              easyToBorrow: a.equityShort?.easyToBorrow ?? null,
            }),
          )
          return [a.symbol, eligibility] as const
        }),
      ),
    )
  })
