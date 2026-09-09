import type { LedgerInput } from '../ledger-plan'
import type { FeeEvent, FillEvent } from '../types'

const hash = (character: string): string => character.repeat(64)

const buy: FillEvent = {
  kind: 'fill',
  id: hash('2'),
  orderId: hash('3'),
  decisionId: hash('4'),
  sessionDate: '2026-08-27',
  symbol: 'NVDA',
  side: 'buy',
  quantityMicros: '1000000',
  referencePriceMicros: '100000000',
  priceMicros: '100000000',
  notionalMicros: '100000000',
  spreadCostMicros: '0',
  slippageCostMicros: '0',
  costBasisMicros: '0',
}

const sell: FillEvent = {
  kind: 'fill',
  id: hash('5'),
  orderId: hash('6'),
  decisionId: hash('7'),
  sessionDate: '2026-08-27',
  symbol: 'NVDA',
  side: 'sell',
  quantityMicros: '1000000',
  referencePriceMicros: '110000000',
  priceMicros: '110000000',
  notionalMicros: '110000000',
  spreadCostMicros: '0',
  slippageCostMicros: '0',
  costBasisMicros: '100000000',
}

const fee: FeeEvent = {
  kind: 'fee',
  id: hash('8'),
  sessionDate: '2026-08-27',
  commissionMicros: '500',
  secMicros: '100',
  tafMicros: '100',
  catMicros: '100',
  totalMicros: '800',
}

/** Minimal closed position with realized gain and explicit costs for pure ledger tests. */
export const makeLedgerInput = (): LedgerInput => ({
  runId: hash('1'),
  initialCapitalMicros: '100000000000',
  inputManifest: { symbols: [{ symbol: 'NVDA' }] },
  events: [buy, sell, fee],
})
