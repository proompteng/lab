import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1 } from '../hash'
import { nativeJevFixture } from '../jev/native.test-support'
import type { IntradayQuote } from '../market-data/intraday/model'
import { ControlExit } from './control-portfolio'
import {
  createMatchedLifecycle,
  finishMatchedLifecycle,
  MatchedEvent,
  stepMatchedLifecycle,
} from './matched-entry-lifecycle'

const fixture = nativeJevFixture()
const at = Date.parse(fixture.observation.payload.observedAt)
const original = fixture.snapshot.latestQuotes['AAPL']
if (original === undefined) throw new Error('Missing fixture quote')
const quote = (t: number, overrides: Partial<IntradayQuote> = {}) => {
  const value = {
    ...original,
    eventAt: new Date(t).toISOString(),
    ingestedAt: new Date(t).toISOString(),
    bidPrice: 100,
    askPrice: 100.02,
    bidSize: 1000,
    askSize: 1000,
    ...overrides,
  }
  return { value, sequence: 1, availableAtMs: t, recordHash: canonicalHashV1(value) }
}
const terms = {
  symbol: 'AAPL',
  protocol: fixture.protocol,
  assumptions: { latencyMs: 100, slippageBps: 0, availableLiquidityPpm: 1000000, feeMultiplierPpm: 1000000 },
  entryBudgetMicros: '10000000000',
  decidedAtMs: at,
  cutoffMs: at + 30 * 60000,
  closeMs: at + 35 * 60000,
}
const step = (
  state: Result.Result.Success<ReturnType<typeof createMatchedLifecycle>>,
  kind: MatchedEvent,
  t: number,
  q: ReturnType<typeof quote> | undefined = quote(t),
) => Result.getOrThrow(stepMatchedLifecycle(state, terms, { kind, atMs: t, quote: q }))
const entry = () =>
  step(
    step(Result.getOrThrow(createMatchedLifecycle(terms.entryBudgetMicros)), MatchedEvent.EntryDecision, at),
    MatchedEvent.EntryArrival,
    at + 100,
  )

test('protective trigger survives partial fills and an unchanged quote cannot replenish liquidity', () => {
  const stopped = step(entry(), MatchedEvent.Poll, at + 5100, quote(at + 5100, { bidPrice: 99, askPrice: 99.02 }))
  const arrival = quote(at + 5200, { bidPrice: 99, askPrice: 99.02, bidSize: 1 })
  const partial = step(stopped, MatchedEvent.ExitArrival, at + 5200, arrival)
  expect(partial.portfolio.ledger.positions[0]?.quantityMicros).toBe('98000000')
  expect(finishMatchedLifecycle(partial).status).toBe('UNRESOLVED')
  expect(finishMatchedLifecycle(partial).netExecutionPnlMicros).toBeNull()
  const exhausted = step(
    step(partial, MatchedEvent.Poll, at + 10100, arrival),
    MatchedEvent.ExitArrival,
    at + 10200,
    arrival,
  )
  expect(exhausted.portfolio.ledger.positions[0]?.quantityMicros).toBe('98000000')
  expect(finishMatchedLifecycle(exhausted).status).toBe('UNRESOLVED')
  expect(finishMatchedLifecycle(exhausted).netExecutionPnlMicros).toBeNull()
  const flat = step(step(exhausted, MatchedEvent.Poll, at + 15100), MatchedEvent.ExitArrival, at + 15200)
  expect(finishMatchedLifecycle(flat).status).toBe('RESOLVED')
  expect(flat.portfolio.episodes[0]?.reason).toBe(ControlExit.ProtectiveStop)
})

test('missing stop observation remains unresolved even after a flat completed exit', () => {
  const missing = Result.getOrThrow(
    stepMatchedLifecycle(entry(), terms, { kind: MatchedEvent.Poll, atMs: at + 5100, quote: undefined }),
  )
  const deadline = at + 100 + 15 * 60000
  const flat = step(step(missing, MatchedEvent.Poll, deadline), MatchedEvent.ExitArrival, deadline + 100)
  expect(flat.portfolio.ledger.positions).toHaveLength(0)
  expect(finishMatchedLifecycle(flat).status).toBe('UNRESOLVED')
  expect(finishMatchedLifecycle(flat).netExecutionPnlMicros).toBeNull()
})

test('maximum hold and close window use the reducing exit lifecycle', () => {
  const deadline = at + 100 + 15 * 60000
  const flat = step(step(entry(), MatchedEvent.Poll, deadline), MatchedEvent.ExitArrival, deadline + 100)
  expect(flat.portfolio.episodes[0]?.reason).toBe(ControlExit.MaximumHold)
  const closed = Result.getOrThrow(
    stepMatchedLifecycle(
      entry(),
      { ...terms, cutoffMs: at + 5000 },
      { kind: MatchedEvent.Poll, atMs: at + 5100, quote: quote(at + 5100) },
    ),
  )
  expect(closed.portfolio.inventory.status === 'EXITING' && closed.portfolio.inventory.reason).toBe(
    ControlExit.SessionClose,
  )
})

test('canceled entry is known zero while absent pricing or arrival is unknown', () => {
  const empty = Result.getOrThrow(createMatchedLifecycle(terms.entryBudgetMicros))
  expect(finishMatchedLifecycle(empty).status).toBe('UNRESOLVED')
  const pending = step(empty, MatchedEvent.EntryDecision, at)
  expect(finishMatchedLifecycle(pending).netExecutionPnlMicros).toBeNull()
  const canceled = step(pending, MatchedEvent.EntryArrival, at + 100, quote(at + 100, { askPrice: 102 }))
  expect(finishMatchedLifecycle(canceled).netExecutionPnlMicros).toBe('0')
  const unknown = Result.getOrThrow(
    stepMatchedLifecycle(pending, terms, { kind: MatchedEvent.EntryArrival, atMs: at + 100, quote: undefined }),
  )
  expect(finishMatchedLifecycle(unknown).netExecutionPnlMicros).toBeNull()
})

test('close window blocks hypothetical entry', () => {
  const state = Result.getOrThrow(
    stepMatchedLifecycle(
      Result.getOrThrow(createMatchedLifecycle(terms.entryBudgetMicros)),
      { ...terms, cutoffMs: at + 100 },
      { kind: MatchedEvent.EntryDecision, atMs: at, quote: quote(at) },
    ),
  )
  expect(state.entry?.status).toBe('SKIPPED')
  expect(finishMatchedLifecycle(state).netExecutionPnlMicros).toBe('0')
})

test('no displayed bid cannot trigger an executable protective exit', () => {
  const state = step(
    entry(),
    MatchedEvent.Poll,
    at + 5100,
    quote(at + 5100, { bidPrice: 99, askPrice: 99.02, bidSize: 0 }),
  )
  expect(state.portfolio.inventory.status).toBe('HOLDING')
  expect(state.exit).toBeNull()
})
