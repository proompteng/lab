import { expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  AlphaV3Direction,
  AlphaV3Engine,
  allocateIntradayAlphaV3,
  decodeAlphaV3Market,
  defaultIntradayAlphaV3Policy as policy,
  evaluateIntradayAlphaV3,
  type AlphaV3Market,
  type AlphaV3SignalState,
  type SipBar,
} from './index'
import { at, bar, blackFriday, emptyState, market, regularSession, usd } from './test-support'

const evaluate = (input: AlphaV3Market, state: AlphaV3SignalState = emptyState) =>
  Result.getOrThrow(evaluateIntradayAlphaV3(policy, input, state))

const orbBars = (aaplVolume: string) => [
  bar(blackFriday, 'AAPL', 0, {
    openMicros: '103000000',
    highMicros: '105000000',
    lowMicros: '102000000',
    closeMicros: '104000000',
    vwapMicros: '104000000',
    volume: aaplVolume,
  }),
  bar(blackFriday, 'AMD', 0, {
    openMicros: '103000000',
    highMicros: '105000000',
    lowMicros: '102000000',
    closeMicros: '104000000',
    vwapMicros: '104000000',
    volume: '250',
  }),
  bar(blackFriday, 'AAPL', 1, {
    openMicros: '104000000',
    highMicros: '107000000',
    lowMicros: '103000000',
    closeMicros: '106000000',
    vwapMicros: '105000000',
  }),
  bar(blackFriday, 'AMD', 1, {
    openMicros: '104000000',
    highMicros: '110000000',
    lowMicros: '103000000',
    closeMicros: '109000000',
    vwapMicros: '105000000',
  }),
]
const orbMarket = (aaplVolume: string, minute = 10) => market(['AAPL', 'AMD'], minute, orbBars(aaplVolume))

test('OR5 includes the exact 2.5× boundary, ranks Top-1 before the touch and uses opposite range stop', () => {
  const onBoundary = evaluate(orbMarket('250'))
  expect(onBoundary.diagnostics.orb.topSymbol).toBe('AAPL')
  expect(onBoundary.diagnostics.orb.candidates[0]).toMatchObject({
    symbol: 'AAPL',
    rvol: 2.5,
    gapAligned: true,
    gapBps: 300,
    gapInAtr: 1.5,
  })
  expect(onBoundary.entries[AlphaV3Engine.Orb]).toEqual({
    symbol: 'AAPL',
    direction: AlphaV3Direction.Long,
    referenceMicros: usd(106),
    atr14Micros: usd(2),
    rangeStopMicros: usd(102),
  })
  const below = evaluate(orbMarket('249'))
  expect(below.diagnostics.orb.candidates[0]).toMatchObject({ rvol: 2.49, reason: 'rvol-below-minimum' })
  expect(below.entries[AlphaV3Engine.Orb]?.symbol).toBe('AMD')
  const noAlternative = orbMarket('249')
  expect(
    evaluate({ ...noAlternative, statuses: noAlternative.statuses.filter(({ symbol }) => symbol === 'AAPL') }).entries[
      AlphaV3Engine.Orb
    ],
  ).toBeNull()
})

test('OR5 does not use the next bar, late opening ranks, post-cutoff statuses, or a late substitute for its winner', () => {
  const opening = orbMarket('250', 5)
  expect(evaluate(opening)).toEqual(
    evaluate({ ...opening, bars: opening.bars.filter(({ startAt }) => startAt < opening.cutoffAt) }),
  )
  expect(evaluate(opening).diagnostics.orb.reason).toBe('awaiting-breakout')
  const input = orbMarket('300')
  const rankLate = input.bars.map((row) =>
    row.symbol === 'AAPL' && row.startAt === blackFriday.regularOpenAt
      ? { ...row, availableAt: at(blackFriday, 6) }
      : row,
  )
  expect(evaluate({ ...input, bars: rankLate }).entries[AlphaV3Engine.Orb]?.symbol).toBe('AMD')

  const halted = {
    symbol: 'AAPL' as const,
    active: false,
    effectiveAt: at(blackFriday, 8),
    availableAt: at(blackFriday, 8),
  }
  expect(evaluate({ ...input, statuses: [...input.statuses, halted] }).diagnostics.orb).toMatchObject({
    topSymbol: 'AAPL',
    reason: 'inactive-winner',
    signal: null,
  })
  expect(
    evaluate({ ...input, statuses: [...input.statuses, { ...halted, availableAt: at(blackFriday, 11) }] }),
  ).toEqual(evaluate(input))
  expect(
    evaluate({
      ...input,
      bars: input.bars.filter((row) => row.symbol !== 'AAPL' || row.startAt === blackFriday.regularOpenAt),
    }).diagnostics.orb.reason,
  ).toBe('incomplete-breakout-path')
})

test('OR5 rejects subthreshold gaps and does not chase a later bar after its first directional touch', () => {
  const input = orbMarket('300', 15)
  const next = bar(blackFriday, 'AAPL', 2, { highMicros: '108000000' })
  expect(evaluate({ ...input, bars: [...input.bars, next] }).diagnostics.orb.reason).toBe('earlier-breakout')

  const weakGap = input.bars.map((row) =>
    row.symbol === 'AAPL' && row.startAt === blackFriday.regularOpenAt
      ? { ...row, openMicros: '100999999', lowMicros: '100900000' }
      : row,
  )
  expect(evaluate({ ...input, bars: weakGap }).diagnostics.orb.candidates[0]).toMatchObject({
    reason: 'gap-below-minimum',
  })
  const oppositeGap = input.bars.map((row) =>
    row.symbol === 'AAPL' && row.startAt === blackFriday.regularOpenAt
      ? { ...row, openMicros: '99000000', lowMicros: '99000000' }
      : row,
  )
  const atTouch = orbMarket('300')
  expect(evaluate({ ...atTouch, bars: oppositeGap }).diagnostics.orb.candidates[0]).toMatchObject({
    reason: 'rankable',
    gapInAtr: -0.5,
    gapAligned: false,
  })
})

test('OR5 is eligible at the last 11:25 checkpoint but does not enter after it', () => {
  const input = orbMarket('300', 115)
  const first = input.bars.filter((row) => row.startAt === blackFriday.regularOpenAt)
  const path = Array.from({ length: 21 }, (_, i) => bar(blackFriday, 'AAPL', i + 1))
  const last = bar(blackFriday, 'AAPL', 22, { highMicros: '107000000', closeMicros: '106000000' })
  const lastCheckpoint = { ...input, bars: [...first, ...path, last] }
  expect(evaluate(lastCheckpoint).entries[AlphaV3Engine.Orb]?.symbol).toBe('AAPL')
  const next = at(blackFriday, 120)
  expect(evaluate({ ...lastCheckpoint, cutoffAt: next, observedAt: next }).diagnostics.orb.reason).toBe(
    'outside-window',
  )
})

const noonSymbols = ['AAPL', 'AMD', 'AMZN', 'NVDA', 'SPY'] as const
const noonMarket = (spread: number, spyOffset = 0) =>
  market(
    noonSymbols,
    150,
    noonSymbols.flatMap((symbol, i) =>
      Array.from({ length: 30 }, (_, slot) =>
        bar(
          blackFriday,
          symbol,
          slot,
          slot !== 29
            ? {}
            : {
                closeMicros: usd(
                  100 + (i === 4 ? spyOffset : spread * ([-1.25, -0.25, 0.25, 1.25][i] ?? 0)),
                ).toString(),
                highMicros: usd(103).toString(),
                lowMicros: usd(97).toString(),
              },
        ),
      ),
    ),
  )

test('noon gates on cross-sectional IQR (not max-min), including the exact 100 bp boundary', () => {
  // [-125, -25, 25, 125] bp: Q1=-50 and Q3=50 by linear interpolation.
  const cutoff = evaluate(noonMarket(1, 0.05))
  expect(cutoff.diagnostics.reversion.iqrBps).toBe(100)
  const exact = cutoff.diagnostics.reversion.iqrExact
  expect(exact).not.toBeNull()
  if (exact === null) throw new Error('Expected exact IQR')
  expect(BigInt(exact.numerator)).toBe(100n * BigInt(exact.denominator))
  expect(cutoff.diagnostics.reversion.diagnostics[0]).toMatchObject({ relativeVwapBps: -130 })
  expect(cutoff.entries[AlphaV3Engine.Reversion].map(({ symbol, direction }) => [symbol, direction])).toEqual([
    ['AAPL', AlphaV3Direction.Long],
    ['AMD', AlphaV3Direction.Long],
    ['AMZN', AlphaV3Direction.Short],
    ['NVDA', AlphaV3Direction.Short],
  ])
  const entries = cutoff.entries
  const orders = Result.getOrThrow(
    allocateIntradayAlphaV3(policy, {
      entries,
      occupied: [],
      openingReferences: new Map(
        entries[AlphaV3Engine.Reversion].map(({ symbol, referenceMicros }) => [symbol, referenceMicros]),
      ),
    }),
  ).orders
  expect(orders.map(({ symbol }) => symbol)).toEqual(['AAPL', 'AMD', 'AMZN', 'NVDA'])
  const below = evaluate(noonMarket(0.999996))
  expect(below.diagnostics.reversion.iqrBps).toBeCloseTo(99.9996, 7)
  expect(below.diagnostics.reversion.reason).toBe('iqr-below-minimum')
  expect(below.entries[AlphaV3Engine.Reversion]).toEqual([])
  expect(evaluate(noonMarket(1, 1.3)).diagnostics.reversion.reason).toBe('missing-opposite-extremes')
})

test('noon never uses future/late bars and removes occupied or incomplete candidates before gating', () => {
  const input = noonMarket(1)
  const future = bar(blackFriday, 'SPY', 30, { closeMicros: usd(101).toString() })
  expect(
    evaluate({ ...input, bars: [...input.bars, future, bar(blackFriday, 'AAPL', -1, { volume: '900000' })] }),
  ).toEqual(evaluate(input))
  const late = input.bars.map((row) =>
    row.symbol === 'AAPL' && row.startAt === at(blackFriday, 145) ? { ...row, availableAt: at(blackFriday, 151) } : row,
  )
  expect(evaluate({ ...input, bars: late }).diagnostics.reversion).toMatchObject({
    reason: 'insufficient-candidates',
    signals: [],
  })
  expect(evaluate(input, { ...emptyState, occupiedSymbols: new Set(['AMD']) }).diagnostics.reversion.reason).toBe(
    'insufficient-candidates',
  )
  const noSpy = input.bars.filter((row) => row.symbol !== 'SPY' || row.startAt !== at(blackFriday, 20))
  expect(evaluate({ ...input, bars: noSpy }).diagnostics.reversion.reason).toBe('unavailable-spy')
  expect(
    evaluate({ ...input, cutoffAt: at(blackFriday, 145), observedAt: at(blackFriday, 145) }).entries[
      AlphaV3Engine.Reversion
    ],
  ).toEqual([])
  expect(evaluate(input, { ...emptyState, noonUsed: true }).diagnostics.reversion.reason).toBe('already-used')
})

test('noon re-ranks remaining names when one symbol halts, without using a future listing status', () => {
  const input = noonMarket(1.2)
  const source = market(['AAPL', 'AMD', 'AMZN', 'NVDA', 'SPY', 'GOOGL'], 150, [])
  const rows = input.bars.filter(({ symbol }) => symbol === 'AAPL').map((row) => ({ ...row, symbol: 'GOOGL' as const }))
  const disabled: AlphaV3Market['statuses'][number] = {
    symbol: 'AAPL',
    active: false,
    availableAt: at(blackFriday, 146),
    effectiveAt: at(blackFriday, 146),
  }
  expect(
    evaluate({ ...source, bars: [...input.bars, ...rows], statuses: [...source.statuses, disabled] }).entries[
      AlphaV3Engine.Reversion
    ].map(({ symbol }) => symbol),
  ).toEqual(['GOOGL', 'AMD', 'AMZN', 'NVDA'])
  const futureStatus = {
    ...source.statuses.find(({ symbol }) => symbol === 'GOOGL'),
    symbol: 'GOOGL' as const,
    active: true,
    effectiveAt: at(blackFriday, 151),
    availableAt: at(blackFriday, 149),
  }
  expect(
    evaluate({ ...source, bars: [...input.bars, ...rows], statuses: [...input.statuses, disabled, futureStatus] })
      .diagnostics.reversion.reason,
  ).toBe('insufficient-candidates')
})

test('noon requires an eligible symbol at the checkpoint and at its actual receipt', () => {
  const input = noonMarket(1.2)
  const afterCutoff = '2026-11-27T17:00:00.500Z'
  const halted = {
    symbol: 'AAPL' as const,
    active: false,
    availableAt: at(blackFriday, 149),
    effectiveAt: at(blackFriday, 149),
  }
  const resumed = { ...halted, active: true, availableAt: afterCutoff, effectiveAt: afterCutoff }
  const haltAfterCutoff = { ...resumed, active: false }
  for (const statuses of [
    [...input.statuses, halted, resumed],
    [...input.statuses, haltAfterCutoff],
  ]) {
    const result = evaluate({ ...input, statuses }).diagnostics.reversion
    expect(result.reason).toBe('insufficient-candidates')
    expect(result.diagnostics[0]).toEqual({ symbol: 'AAPL', reason: 'inactive' })
  }
})

const noiseMarket = (cutoff: number, close: number, session = blackFriday) =>
  market(
    ['QQQ', 'SMH'],
    cutoff,
    [
      bar(session, 'QQQ', 0),
      bar(session, 'QQQ', cutoff / 5 - 1, {
        closeMicros: usd(close).toString(),
        highMicros: usd(103).toString(),
        lowMicros: usd(97).toString(),
      }),
    ],
    session,
  )

test('Noise Area uses only the matched completed prior 30-minute slots and compares exactly against 1.2× bands', () => {
  const input = noiseMarket(30, 103)
  const first = evaluate(input)
  expect(first.diagnostics.noise[0]).toMatchObject({
    symbol: 'QQQ',
    reason: 'signal',
    upperMicros: usd(102.212),
    lowerMicros: usd(98.8),
    bandWidthBps: 120,
  })
  expect(first.entries[AlphaV3Engine.Noise]).toHaveLength(1)
  expect(first.diagnostics.noise[1]).toMatchObject({ symbol: 'SMH', reason: 'missing-current-bar' })
  expect(evaluate(noiseMarket(30, 102.212)).entries[AlphaV3Engine.Noise]).toEqual([])
  expect(evaluate(noiseMarket(30, 98)).entries[AlphaV3Engine.Noise][0]?.direction).toBe(AlphaV3Direction.Short)
  expect(evaluate({ ...input, bars: [...input.bars, bar(blackFriday, 'QQQ', 6)] })).toEqual(first)
  const late = input.bars.map((row) =>
    row.startAt === at(blackFriday, 25) ? { ...row, availableAt: at(blackFriday, 31) } : row,
  )
  expect(evaluate({ ...input, bars: late }).diagnostics.noise[0]?.reason).toBe('missing-current-bar')
  expect(evaluate(input, { ...emptyState, noiseUsed: new Set(['QQQ']) }).entries[AlphaV3Engine.Noise]).toEqual([])
})

test('Noise Area enters on the clamped edge, manages opposite-band exits after entry cutoff, and never enters outside it', () => {
  expect(evaluate(noiseMarket(180, 103)).entries[AlphaV3Engine.Noise]).toHaveLength(1)
  expect(evaluate(noiseMarket(210, 103)).entries[AlphaV3Engine.Noise]).toEqual([])
  const full = regularSession(blackFriday.date)
  expect(evaluate(noiseMarket(330, 103, full)).entries[AlphaV3Engine.Noise]).toHaveLength(1)
  const afterEntry = noiseMarket(360, 98, full)
  expect(evaluate(afterEntry).entries[AlphaV3Engine.Noise]).toEqual([])
  const held = { ...emptyState, noisePositions: new Map([['QQQ', AlphaV3Direction.Long]] as const) }
  expect(evaluate(afterEntry, held).diagnostics.noise[0]).toMatchObject({
    reason: 'opposite-band',
    exit: { symbol: 'QQQ', reason: 'opposite-band' },
    signal: null,
  })
  const input = noiseMarket(240, 103, full)
  const earlyPrior: AlphaV3Market['session'] = {
    ...blackFriday,
    date: '2026-11-25',
    regularOpenAt: '2026-11-25T14:30:00.000Z',
    regularCloseAt: '2026-11-25T18:00:00.000Z',
    sessionOpenAt: '2026-11-25T13:00:00.000Z',
    sessionCloseAt: '2026-11-25T22:00:00.000Z',
  }
  expect(
    evaluate({
      ...input,
      priorSessions: input.priorSessions.map((row) =>
        row.session.date === earlyPrior.date ? { ...row, session: earlyPrior } : row,
      ),
    }).diagnostics.noise[0]?.reason,
  ).toBe('missing-prior-checkpoint')
})

test('market decoder rejects IEX and global evaluation fails closed on duplicates, impossible timing or future history', () => {
  const input = orbMarket('300')
  expect(Result.isSuccess(decodeAlphaV3Market(input))).toBe(true)
  expect(Result.isFailure(decodeAlphaV3Market({ ...input, feed: 'iex' }))).toBe(true)
  expect(Result.isFailure(evaluateIntradayAlphaV3(policy, { ...input, observedAt: 'invalid' }, emptyState))).toBe(true)
  const duplicate = input.bars.slice(0, 1)
  expect(
    Result.isFailure(evaluateIntradayAlphaV3(policy, { ...input, bars: [...input.bars, ...duplicate] }, emptyState)),
  ).toBe(true)
  const premature = input.bars.map((row): SipBar => ({ ...row, availableAt: row.startAt }))
  expect(Result.isFailure(evaluateIntradayAlphaV3(policy, { ...input, bars: premature }, emptyState))).toBe(true)
  expect(
    Result.isFailure(
      evaluateIntradayAlphaV3(
        policy,
        {
          ...input,
          priorSessions: [...input.priorSessions, { session: blackFriday, bars: [] }],
        },
        emptyState,
      ),
    ),
  ).toBe(true)
})
