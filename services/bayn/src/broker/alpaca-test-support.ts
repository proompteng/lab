import { Effect } from 'effect'

import type { BrokerReadShape } from './alpaca/model'

export const unusedAssetBySymbol: BrokerReadShape['assetBySymbol'] = () =>
  Effect.die(new Error('unexpected Alpaca asset read'))

export const unusedMarketCalendar: BrokerReadShape['marketCalendar'] = () =>
  Effect.die(new Error('unexpected Alpaca market calendar read'))
