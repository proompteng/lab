import { Effect, Result } from 'effect'
import { AccountStatus, AssetClass, AssetExchange, AssetStatus, type BrokerReadShape } from '../broker/alpaca/model'
import { normalizeAccountConfigurationResult, normalizeAssetResult } from '../broker/alpaca/normalizers'
import type { AccountSnapshot } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'

const entryBrokerReads = (
  account: AccountSnapshot,
  observedAt: string,
  shortingEnabled: boolean,
): Pick<BrokerReadShape, 'account' | 'accountConfiguration' | 'assetBySymbol'> => {
  const read = <A>(value: A) =>
    Effect.succeed({
      value,
      evidence: {
        requestId: 'long-entry-fixture',
        status: 200,
        contentHash: Result.getOrThrow(canonicalHashV1Result(value)),
        observedAt,
      },
    })
  return {
    account: read({
      id: account.accountId,
      status: AccountStatus.Active,
      currency: 'USD',
      cashMicros: account.cashMicros,
      cashReportingQuantumMicros: '1',
      equityMicros: account.equityMicros,
      lastEquityMicros: account.equityMicros,
      cryptoStatus: null,
      cryptoFeeTier: null,
      nonMarginableBuyingPowerMicros: null,
      buyingPowerMicros: account.buyingPowerMicros,
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      shortingEnabled,
      observedAt,
    }),
    accountConfiguration: read(
      Result.getOrThrow(
        normalizeAccountConfigurationResult({ fractional_trading: true, no_shorting: !shortingEnabled }, observedAt),
      ),
    ),
    assetBySymbol: (symbol) =>
      read(
        Result.getOrThrow(
          normalizeAssetResult(
            {
              id: '12345678-1234-4234-8234-123456789abc',
              symbol,
              class: AssetClass.UsEquity,
              exchange: AssetExchange.Nasdaq,
              status: AssetStatus.Active,
              tradable: true,
              fractionable: true,
              marginable: true,
              shortable: shortingEnabled,
              easy_to_borrow: shortingEnabled,
            },
            symbol,
            observedAt,
          ),
        ),
      ),
  }
}

/** Long-only fixtures explicitly observe disabled broker shorting. */
export const longEntryBrokerReads = (account: AccountSnapshot, observedAt: string) =>
  entryBrokerReads(account, observedAt, false)

export const shortEntryBrokerReads = (account: AccountSnapshot, observedAt: string) =>
  entryBrokerReads(account, observedAt, true)
