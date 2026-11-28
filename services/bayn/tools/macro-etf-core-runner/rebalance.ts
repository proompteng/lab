import { Clock, Effect } from 'effect'

import { utcInstantFromEpochMillis } from '../../src/time'
import type { Alpaca } from '../macro-canary-runner/alpaca'
import type { Snapshot } from '../macro-canary-runner/planner'
import { computeAllocation } from './allocation'
import { failure, type Options } from './contract'
import { readMarket } from './market'
import { planRebalance } from './planner'

export const prepareMacroEtfCoreRebalance = Effect.fn('macro-etf-core.plan')(function* (
  alpaca: Alpaca,
  snapshot: Snapshot,
  options: Pick<Options, 'profile' | 'excludeSymbols' | 'capitalBudgetCents' | 'tif'>,
) {
  const market = yield* readMarket(alpaca)
  const { window } = market
  const allocation = yield* Effect.fromResult(computeAllocation(options.profile, market, options.excludeSymbols))
  const plan = yield* Effect.fromResult(planRebalance(snapshot, options, allocation, market))
  const observedAt = yield* Clock.currentTimeMillis
  if (observedAt >= window.cutoff)
    return yield* failure('calendar', 'Next-open planning window expired while building the plan')

  const material = {
    schemaVersion: 'bayn.macro-etf-core-rebalance-receipt.v1',
    broker: 'alpaca-paper',
    profile: options.profile,
    configuredExclusions: options.excludeSymbols,
    configuredBudgetCents: options.capitalBudgetCents,
    signalSession: window.lastDate,
    signalCloseAt: window.lastCloseAt,
    executionSession: window.executionDate,
    executionOpenAt: window.executionOpenAt,
    tif: options.tif,
    barSha256: market.barSha256,
    signalBars: {
      feed: 'sip',
      timeframe: '1Day',
      adjustment: market.evidence.snapshot.adjustment,
      sessions: market.evidence.snapshot.bars.length,
      snapshotSha256: market.evidence.snapshotHash,
      missingCandidates: market.missingCandidates,
    },
    rawSizingBars: { feed: 'sip', timeframe: '1Day', adjustment: 'raw', rows: market.rawBars },
    allocation,
    plan,
  }
  return { material, timestamp: utcInstantFromEpochMillis(observedAt), window }
})
