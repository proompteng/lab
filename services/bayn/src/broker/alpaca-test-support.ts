import { Effect } from 'effect'

import type { BrokerReadShape } from './alpaca'

export const unusedMarketCalendar: BrokerReadShape['marketCalendar'] = () =>
  Effect.die(new Error('unexpected Alpaca market calendar read'))
