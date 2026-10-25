import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import type { FeeActivity } from '../broker/alpaca/model'
import { receivedCryptoFee } from '../strategy/execution-model/fees'
import type { EconomicReplayFill } from './ledger'

export const replayFeeActivity = (
  accountId: string,
  fill: EconomicReplayFill & { readonly brokerOrderId: string; readonly executionIndex: number },
  previousFeesMicros: string,
  nextFeesMicros: string,
  feeMultiplierPpm: number,
): FeeActivity | null => {
  const fee = BigInt(nextFeesMicros) - BigInt(previousFeesMicros)
  if (fee === 0n) return null
  const received = receivedCryptoFee(
    { ...fill, quantityAtoms: BigInt(fill.quantityAtoms), notionalMicros: BigInt(fill.notionalMicros) },
    BigInt(feeMultiplierPpm),
    cryptoMaximumTakerFeeBps,
  )
  return {
    accountId,
    activityId: `fee::${fill.brokerOrderId}::${fill.executionIndex}`,
    date: fill.observedAt.slice(0, 10),
    netAmountMicros: (-(fee - received.valueMicros + received.cashMicros)).toString(),
    ...(received.cashMicros > 0n ? { cryptoCashFee: true as const } : {}),
    ...(received.quantityAtoms === 0n
      ? {}
      : {
          coinDebit: {
            symbol: fill.symbol,
            quantityAtoms: received.quantityAtoms.toString(),
            priceAtoms: (BigInt(fill.priceMicros) * 1000n).toString(),
          },
        }),
  }
}
