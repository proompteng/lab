import { expect, test } from 'bun:test'
import { nativeAlphaDecisionFixture } from './alpha-decision.test-support'
import {
  makeAlphaStreamingSnapshot,
  makeTestTrailingBaseline,
  makeFlatAlphaPortfolio as makeFlatPortfolio,
} from './test-support'
import { Effect, Fiber, Layer, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { normalizeMarketCalendarResult } from '../../broker/alpaca/normalizers'
import {
  AccountStatus,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
  type Fill,
  type Order,
  type Position,
} from '../../execution/contracts'
import { executionMandateAllocationCapitalMicros } from '../../execution/mandate'
import type { EquityShortEligibility } from '../../execution/equity-short'
import { canonicalHashV1Result } from '../../hash'
import { CycleState } from '../../cycle/model'
import { makeIntradayAlphaRuntime } from '../../intraday-replay/strategy'
import { closeWindowForCycle } from '../../observe-composition/execution-cycle'
import { decodeExecutionDecisionDocument } from '../../shadow-decision-contract'
import { verifyReportJob } from '../../forward-performance-verification-worker'
import { ReportVerificationTask } from '../../forward-performance/verification'
import { AlphaDecisionJsonRow, verifyAlphaDecisionJson } from '../../forward-performance/postgres/alpha-decisions'
import { readPerformanceAlphaDecisionCursor } from '../../forward-performance/postgres/decision-cursor'
import { JevClient, JevError, type JevInference } from '../../jev/client'
import { JevFailure } from '../../jev/contract'
import { JevExitReason, decideJevExit } from '../../jev/exit'
import {
  JevPortfolioSchema,
  JevPurpose,
  currentProtectionEvidenceVersion,
  decodeJevPortfolio,
} from '../../jev/portfolio'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../../jev/protocol'
import { compileJevEntry } from '../../jev/runtime'
import { IntradayTrailingBaseline } from '../../market-data/intraday/trailing-baseline'
import { CandidateObservationStore } from '../../observe-composition/candidate-observation'
import { prepareObserveStartup } from '../../observe-composition/startup'
import { IsoDateSchema, strictParseOptions } from '../../schemas'
import { reconciledStateHash } from '../../simulation-reconciliation/broker-model'
import { priceNumberToMicros } from '../execution-model/fixed-point'
import { TargetPlanStatus, planTargets, quoteBoundTargetPlannerInputSchemaVersion } from '../../target-planner/index'
import { fixtureRuntime } from '../../testing/runtime-fixtures'
import { utcInstantFromEpochMillis } from '../../time'
import { evaluateCatalystVetos } from './catalyst-veto'
import {
  IntradayAlphaDecisionReason,
  IntradayAlphaTargetSchema,
  decideIntradayAlphaEntry,
  isBalancedMiddayBasket,
} from './decision'
import { makeOwnedIntradayAlphaObservation, reproduceIntradayAlphaObservation } from './observation'
import {
  IntradayAlphaPhase,
  IntradayAlphaSetup,
  decodeIntradayAlphaPolicy,
  intradayAlphaCandidateSymbols,
  intradayAlphaStrategyIdentity,
  makeIntradayAlphaPolicy,
} from './policy'
import { evaluateIntradayAlphaFromSnapshot, makeIntradayAlphaEntryQuery } from './runtime'
import {
  computeObservedSessionVwap,
  computeOpeningRange,
  extractIntradayAlphaCandidates,
  resolveAlphaRegularSession,
  selectIntradayAlphaLegs,
} from './signals'

const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)('2026-09-04')
const sessionOpenMs = Date.parse('2026-09-04T13:30:00.000Z') // 09:30 EDT
const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
const policy = makeIntradayAlphaPolicy(protocol)
const accountId = 'alpha-test-account'
const cycleId = '1'.repeat(64)
const authorityGenerationHash = '2'.repeat(64)

const testTrailingBaseline = makeTestTrailingBaseline()
const testTrailingBaselineLayer = Layer.succeed(IntradayTrailingBaseline, {
  load: () => Effect.succeed(testTrailingBaseline),
})

const makeShortEligibility = (
  symbols: readonly string[],
  observedAt: string,
  shortableSymbols: ReadonlySet<string> = new Set(symbols),
): Readonly<Record<string, EquityShortEligibility>> =>
  Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      {
        schemaVersion: 'bayn.equity-short-eligibility.v1' as const,
        accountId,
        symbol,
        accountHash: 'a'.repeat(64),
        configurationHash: 'b'.repeat(64),
        assetHash: 'c'.repeat(64),
        accountObservedAt: observedAt,
        configurationObservedAt: observedAt,
        assetObservedAt: observedAt,
        accountActive: true,
        shortingEnabled: true,
        noShorting: false,
        assetActive: true,
        tradable: true,
        marginable: true,
        shortable: shortableSymbols.has(symbol),
        easyToBorrow: shortableSymbols.has(symbol),
      },
    ]),
  )

test('gap-resilient session VWAP and 30m Opening Range handle silent IEX minutes accurately', () => {
  // Simulate COHR with 4 missing morning minutes (where Flink recursive VWAP returns GAP)
  const { snapshot } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121, // 11:30 completed bar -> rangeEnd 11:31
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -250, gapMinutes: [5, 17, 42, 88] },
    },
  })
  const cohrBars = snapshot.bars.filter((bar) => bar.symbol === 'COHR')
  expect(cohrBars.length).toBe(117)
  const vwap = computeObservedSessionVwap(cohrBars, sessionOpenMs, Date.parse(snapshot.manifest.rangeEndAt))
  expect(vwap).not.toBeNull()
  expect(vwap ?? 0).toBeGreaterThan(97)
  expect(vwap ?? 0).toBeLessThan(100.5)

  const orb = computeOpeningRange(cohrBars, sessionOpenMs, 30, 24)
  expect(orb).not.toBeNull()
  expect(orb?.barCount).toBe(28)
})

test('resolves 09:30–16:00 ET regular hours even on extended 08:00–17:00 ET Alpaca calendars', () => {
  const extendedCalendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      [{ session_open: '0400', session_close: '2000', date: '2026-09-04', open: '09:30', close: '16:00' }],
      { start: '2026-09-04', end: '2026-09-04' },
    ),
  )
  // Calendar sessions envelope is 08:00–17:00 EDT (12:00Z–21:00Z), while regular hours are 09:30–16:00 EDT (13:30Z–20:00Z).
  expect(extendedCalendar.sessions[0]?.openAt).toBe('2026-09-04T12:00:00.000Z')
  const regular = Result.getOrThrow(resolveAlphaRegularSession(extendedCalendar, sessionDate))
  expect(regular.openAt).toBe('2026-09-04T13:30:00.000Z')
  expect(regular.closeAt).toBe('2026-09-04T20:00:00.000Z')

  // Pre-market (08:30 EDT = 12:30Z) waits cleanly for the first completed RTH minute instead of shifting clocks.
  const preMarket = makeIntradayAlphaEntryQuery({
    policy,
    calendar: extendedCalendar,
    sessionDate,
    observedAtMs: Date.parse('2026-09-04T12:30:02.000Z'),
  })
  expect(Result.isFailure(preMarket)).toBe(true)
  if (Result.isFailure(preMarket)) {
    expect(preMarket.failure._tag).toBe('JevAwaitingEvidence')
  }

  // Regular midday (11:31:02 EDT = 15:31:02Z) anchors rangeStartAt to 09:30 EDT (13:30Z), NOT 08:00 EDT!
  const middayQuery = Result.getOrThrow(
    makeIntradayAlphaEntryQuery({
      policy,
      calendar: extendedCalendar,
      sessionDate,
      observedAtMs: Date.parse('2026-09-04T15:31:02.000Z'),
    }),
  )
  expect(middayQuery.rangeStartAt).toBe('2026-09-04T13:30:00.000Z')
  expect(middayQuery.rangeEndAt).toBe('2026-09-04T15:31:00.000Z')

  // Post-market (16:05 EDT = 20:05Z) waits cleanly instead of creating >390m snapshot queries.
  const postMarket = makeIntradayAlphaEntryQuery({
    policy,
    calendar: extendedCalendar,
    sessionDate,
    observedAtMs: Date.parse('2026-09-04T20:05:02.000Z'),
  })
  expect(Result.isFailure(postMarket)).toBe(true)
  if (Result.isFailure(postMarket)) {
    expect(postMarket.failure._tag).toBe('JevAwaitingEvidence')
  }
})

test('Phase 2 Morning ORB30 requires Zarattini opening-candle direction, tolerates wide IEX spreads, and caps hold before 11:28 ET', () => {
  // Minute 40 from open (10:10 ET): rangeEnd = 10:11 ET -> completedMinuteFromOpen = 40
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 41,
    spyProfile: { basePrice: 550, endReturnBps: 45 }, // SPY > session VWAP
    profiles: {
      NVDA: {
        basePrice: 140,
        endReturnBps: 40, // green opening range (orClose > orOpen)
        openingRangeHigh: 141.0,
        openingRangeLow: 139.0,
        overridePrevClose: 140.9,
        overrideLatestClose: 141.65,
        spreadBps: 180, // wide single-exchange IEX quote must NOT block bar-close-anchored entry!
      },
      AMD: {
        basePrice: 160,
        endReturnBps: -30, // red opening range (orClose < orOpen) -> blocked for LONG by Zarattini rule!
        openingRangeHigh: 160.2,
        openingRangeLow: 158.0,
        overridePrevClose: 160.1,
        overrideLatestClose: 161.2,
        spreadBps: 6,
      },
    },
  })
  const portfolio = makeFlatPortfolio(observedAt)
  const eligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt)
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio,
      snapshot,
      trailingBaseline: testTrailingBaseline,
      equityShortEligibility: eligibility,
    }),
  )
  const target = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: [],
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )

  expect(target.phase).toBe(IntradayAlphaPhase.MorningOrb)
  expect(target.reason).toBe(IntradayAlphaDecisionReason.SelectedMorningOrb)
  expect(target.selectedSymbols).toEqual(['NVDA'])
  // ATR14 = 4.0% -> stop = 140bp, target = 280bp, weight = min(0.35, 50/140) = 0.35
  expect(target.targetWeights['NVDA']).toBe(0.35)
  const nvdaPlan = target.exitPolicy.plans['NVDA']
  expect(nvdaPlan?.schemaVersion).toBe('bayn.intraday-alpha-long-funded-exit-plan.v1')
  expect(nvdaPlan?.levels.maximumHoldingMinutes).toBe(60)
  // Entry ceiling anchors to completed bar close ($141.65 + 10 bps = $141.79), NOT the wide IEX ask ($142.92)!
  expect(
    nvdaPlan?.schemaVersion === 'bayn.intraday-alpha-long-funded-exit-plan.v1' &&
      Number(nvdaPlan.levels.maximumEntryPriceMicros) / 1_000_000,
  ).toBeCloseTo(141.79, 2)
  expect(Result.isSuccess(Schema.decodeUnknownResult(IntradayAlphaTargetSchema, strictParseOptions)(target))).toBe(true)

  // Re-entry blocked when NVDA already taken or maxTradesPerSession (1) reached
  const blockedSame = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: owned.payload,
        morningOrbTakenSymbols: ['NVDA'],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: [],
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )
  expect(blockedSame.selectedSymbols).toEqual([])
  expect(blockedSame.reason).toBe(IntradayAlphaDecisionReason.NoSignal)

  // Late morning entry (minute 80 = 10:50 ET): hold must be capped at 118 - 81 = 37 minutes (< 60)
  const late = makeAlphaStreamingSnapshot({
    minutesFromOpen: 81,
    spyProfile: { basePrice: 550, endReturnBps: 50 },
    profiles: {
      NVDA: {
        basePrice: 140,
        endReturnBps: 45,
        openingRangeHigh: 141.0,
        openingRangeLow: 139.0,
        overridePrevClose: 140.95,
        overrideLatestClose: 141.7,
      },
    },
  })
  const lateExtracted = Result.getOrThrow(
    extractIntradayAlphaCandidates({
      snapshot: late.snapshot,
      policy,
      trailingBaseline: testTrailingBaseline,
      accountId,
      equityShortEligibility: makeShortEligibility(intradayAlphaCandidateSymbols, late.observedAt),
    }),
  )
  const lateLegs = selectIntradayAlphaLegs({
    context: lateExtracted.context,
    policy,
    longPool: lateExtracted.longPool,
    shortPool: lateExtracted.shortPool,
    vetoedSymbols: new Set(),
  })
  expect(lateLegs[0]?.symbol).toBe('NVDA')
  expect(lateLegs[0]?.maximumHoldingMinutes).toBe(37)
})

test('Phase 2 Morning ORB30 selects Short breakdown with short exit plan when SPY < VWAP and borrowable', () => {
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 36, // 10:05 ET completed
    spyProfile: { basePrice: 550, endReturnBps: -55 }, // SPY < session VWAP
    profiles: {
      MU: {
        basePrice: 110,
        endReturnBps: -60,
        openingRangeHigh: 110.5,
        openingRangeLow: 109.2,
        overridePrevClose: 109.25,
        overrideLatestClose: 108.6,
      },
    },
  })
  const portfolio = makeFlatPortfolio(observedAt)
  const eligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt)
  const muBaseline = makeTestTrailingBaseline({ MU: { atr14Ratio: 0.06 } })
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio,
      snapshot,
      trailingBaseline: muBaseline,
      equityShortEligibility: eligibility,
    }),
  )
  const target = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: [],
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )

  expect(target.selectedSymbols).toEqual(['MU'])
  // High-vol MU (ATR14 = 6% -> stop = 210bp) scales down via inverse-ATR: round4(50 / 210) = 0.2381
  expect(target.targetWeights['MU']).toBe(-0.2381)
  expect(target.exitPolicy.plans['MU']?.schemaVersion).toBe('bayn.intraday-alpha-short-funded-exit-plan.v1')
  expect(target.exitPolicy.plans['MU']?.levels.source.setup).toBe(IntradayAlphaSetup.Orb30Short)
})

test('Phase 1 Midday Reversion selects 2L + 2S dollar-neutral portfolio, falls through catalyst vetos, and plans 4 legs inside $100k cash BP', () => {
  // Minute 120 from open (11:30 ET completed -> rangeEnd 11:31 ET)
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    spyProfile: { basePrice: 550, endReturnBps: 10 },
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -420, gapMinutes: [12, 44], spreadBps: 210 }, // #1 oversold (wide IEX spread allowed)
      LITE: { basePrice: 90, endReturnBps: -310, spreadBps: 240 }, // #2 oversold -> Long
      WDC: { basePrice: 70, endReturnBps: -220 }, // #3 oversold -> Long (on COHR veto)
      SNDK: { basePrice: 60, endReturnBps: 380, spreadBps: 150 }, // #1 overbought -> Short
      MU: { basePrice: 80, endReturnBps: 290, spreadBps: 90 }, // #2 overbought -> Short
      MRVL: { basePrice: 85, endReturnBps: 180 }, // #3 overbought
    },
  })
  const portfolio = makeFlatPortfolio(observedAt, '100000000000', '100000000000') // exact 1x $100k cash account
  const eligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt)
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio,
      snapshot,
      trailingBaseline: testTrailingBaseline,
      equityShortEligibility: eligibility,
    }),
  )
  // Verify cryptographic observation reproduction round-trip!
  const reproducedObs = Result.getOrThrow(reproduceIntradayAlphaObservation(owned.payload))
  expect(reproducedObs.contentHash).toBe(owned.contentHash)

  // 1) Normal 2L + 2S selection without vetos -> Long COHR, LITE + Short MU, SNDK
  const target = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: owned.payload,
        morningOrbTakenSymbols: ['NVDA'],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: [],
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )

  expect(target.phase).toBe(IntradayAlphaPhase.MiddayReversion)
  expect(target.reason).toBe(IntradayAlphaDecisionReason.SelectedMiddayReversion)
  expect(target.selectedSymbols).toEqual(['COHR', 'LITE', 'MU', 'SNDK'])
  expect(target.targetWeights['COHR']).toBe(0.18)
  expect(target.targetWeights['LITE']).toBe(0.18)
  expect(target.targetWeights['MU']).toBe(-0.18)
  expect(target.targetWeights['SNDK']).toBe(-0.18)
  expect(Result.isSuccess(Schema.decodeUnknownResult(IntradayAlphaTargetSchema, strictParseOptions)(target))).toBe(true)

  // 2) Run actual production compileJevEntry + target-planner planTargets on the 4-leg (2L + 2S) target!
  const compiled = Result.getOrThrow(compileJevEntry(target, snapshot, snapshot))
  const priceMicros: Record<string, string> = {}
  const bidPriceMicros: Record<string, string> = {}
  const askPriceMicros: Record<string, string> = {}
  for (const symbol of Object.keys(compiled.planningTargetWeights ?? {})) {
    const q = snapshot.latestQuotes[symbol]
    if (q === undefined) continue
    priceMicros[symbol] =
      compiled.priceMicros[symbol] ?? Result.getOrThrow(priceNumberToMicros(q.askPrice, 'p', 'UP')).toString()
    bidPriceMicros[symbol] =
      compiled.bidPriceMicros?.[symbol] ?? Result.getOrThrow(priceNumberToMicros(q.bidPrice, 'b', 'DOWN')).toString()
    askPriceMicros[symbol] =
      compiled.askPriceMicros?.[symbol] ?? Result.getOrThrow(priceNumberToMicros(q.askPrice, 'a', 'UP')).toString()
  }
  const refMaterial = {
    schemaVersion: 'bayn.intraday-snapshot-reference-prices.v1' as const,
    snapshotId: snapshot.manifest.snapshotId,
    snapshotContentHash: snapshot.manifest.contentHash,
    priceReference: 'verified-adverse-quote-boundary' as const,
    signalDate: sessionDate,
    observedAt: snapshot.manifest.observedAt,
    priceMicros,
    bidPriceMicros,
    askPriceMicros,
  }
  const refHash = Result.getOrThrow(canonicalHashV1Result(refMaterial))
  const plannerInput = {
    schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
    strategyName: 'jev',
    cycleId,
    decisionHash: '3'.repeat(64),
    policyHash: '4'.repeat(64),
    accountId,
    signalDate: sessionDate,
    targetWeights: compiled.planningTargetWeights ?? target.targetWeights,
    referencePrices: { ...refMaterial, contentHash: refHash },
    brokerState: portfolio.brokerState,
    precision: protocol.executionModel.precision,
    allocationCapitalMicros: portfolio.brokerState.account.equityMicros,
    maximumInputAgeMs: 60_000,
    submissionCutoffAt: utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000),
    observedAt,
    executionTerms: {
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      priceReference: 'verified-adverse-quote-boundary',
      snapshotId: snapshot.manifest.snapshotId,
      snapshotContentHash: snapshot.manifest.contentHash,
      maximumBuyQuantityAtoms: compiled.maximumBuyQuantityAtoms,
      maximumSellQuantityAtoms: compiled.maximumSellQuantityAtoms,
      equityShortEntries: Object.fromEntries(
        ['MU', 'SNDK'].map((symbol) => [symbol, eligibility[symbol]]).filter((entry) => entry[1] !== undefined),
      ),
    },
  } as const
  const planned = Result.getOrThrow(planTargets(plannerInput))
  // Proves 2L + 2S at 18% per leg (36% Long + 54% Short collateral = 90% BP) plans with ZERO InsufficientBuyingPower!
  expect(planned.status).toBe(TargetPlanStatus.Planned)
  expect(planned.intentTargets.length).toBe(4)
  expect(
    planned.intentTargets
      .filter((intent) => intent.side === OrderSide.Buy)
      .map((i) => i.symbol)
      .sort(),
  ).toEqual(['COHR', 'LITE'])
  expect(
    planned.intentTargets
      .filter((intent) => intent.side === OrderSide.Sell)
      .map((i) => i.symbol)
      .sort(),
  ).toEqual(['MU', 'SNDK'])
  expect(isBalancedMiddayBasket(planned, target.selectedSymbols)).toBe(true)

  // Shallow IEX displayed bidSize (100 shares) must NOT throttle consolidated-NBBO intraday-alpha shorts!
  const shallowShortQuotes = {
    ...snapshot,
    latestQuotes: Object.fromEntries(
      Object.entries(snapshot.latestQuotes).map(([symbol, quote]) => [
        symbol,
        symbol === 'MU' || symbol === 'SNDK' ? { ...quote, bidSize: 100 } : quote,
      ]),
    ),
  }
  const uncapped = Result.getOrThrow(compileJevEntry(target, snapshot, shallowShortQuotes))
  const uncappedPlan = Result.getOrThrow(
    planTargets({
      ...plannerInput,
      executionTerms: {
        ...plannerInput.executionTerms,
        maximumSellQuantityAtoms: uncapped.maximumSellQuantityAtoms,
      },
    }),
  )
  expect(uncappedPlan.status).toBe(TargetPlanStatus.Planned)
  expect(isBalancedMiddayBasket(uncappedPlan, target.selectedSymbols)).toBe(true)
  expect(
    uncappedPlan.intentTargets
      .filter(({ side }) => side === OrderSide.Sell)
      .every(({ quantityAtoms }) => BigInt(quantityAtoms) > 100_000_000_000n),
  ).toBe(true)

  // 3) Catalyst veto on #1 oversold (COHR) cleanly falls through to #3 (WDC) instead of starving!
  const withVeto = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: [],
        catalystVetos: [
          {
            symbol: 'COHR',
            phase: IntradayAlphaPhase.MiddayReversion,
            direction: 'LONG',
            status: 'ASSESSED',
            requestHash: '5'.repeat(64),
            responseHash: '6'.repeat(64),
            vetoProbability: 0.94,
            vetoed: true,
            recordedAt: observedAt,
          },
        ],
        decidedAt: observedAt,
      },
      policy,
    ),
  )
  expect(withVeto.selectedSymbols).toEqual(['LITE', 'MU', 'SNDK', 'WDC'])

  // 4) Single-extreme anti-starvation fallback if zero equities are shortable
  const longOnlyEligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt, new Set())
  const longOnlyOwned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio,
      snapshot,
      trailingBaseline: testTrailingBaseline,
      equityShortEligibility: longOnlyEligibility,
    }),
  )
  const fallbackTarget = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: longOnlyOwned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: [],
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )
  expect(fallbackTarget.selectedSymbols).toEqual(['COHR'])
  expect(fallbackTarget.targetWeights['COHR']).toBe(0.2)
})

test('catalyst veto fails open to quant signal on JevClient outage instead of starving entries', async () => {
  const { snapshot, observedAt, rangeEndAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    spyProfile: { basePrice: 550, endReturnBps: 0 },
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -350 },
      LITE: { basePrice: 90, endReturnBps: -280 },
      SNDK: { basePrice: 60, endReturnBps: 340 },
      MU: { basePrice: 80, endReturnBps: 250 },
    },
  })
  const portfolio = makeFlatPortfolio(observedAt)
  const eligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt)
  const recorded: string[] = []
  let middayCompleted = false
  const failingJevClient = Layer.succeed(JevClient, {
    evaluate: () =>
      Effect.fail(
        new JevError({
          failure: JevFailure.Transport,
          message: 'TypeSafe provider unreachable',
        }),
      ),
  })
  const obsStore = Layer.succeed(CandidateObservationStore, {
    record: (obs) =>
      Effect.sync(() => {
        recorded.push(obs.contentHash)
      }),
    latestJevWindowEnd: () => Effect.succeed(Option.none()),
    readIntradayAlphaSessionState: () =>
      Effect.sync(() => ({
        morningOrbTakenSymbols: [],
        middayReversionCompleted: middayCompleted,
        noiseAreaTakenSymbols: [],
      })),
  })

  const candidate = {
    model: policy.catalystVeto.model,
    symbol: 'COHR',
    phase: IntradayAlphaPhase.MiddayReversion,
    direction: 'LONG' as const,
    windowEndAt: rangeEndAt,
    sessionOpenPrice: 100,
    sessionVwap: 98.5,
    latestClose: 96.5,
    relVwapDevBps: -200,
    recentBars: snapshot.bars
      .filter((b) => b.symbol === 'COHR')
      .slice(-5)
      .map(({ eventAt, open, high, low, close, volume }) => ({ eventAt, open, high, low, close, volume })),
  } as const
  const receipts = await Effect.runPromise(
    evaluateCatalystVetos({
      candidates: [candidate],
      vetoThreshold: 0.85,
      budgetMs: 5_000,
      recordedAt: observedAt,
    }).pipe(Effect.provide(failingJevClient)),
  )
  expect(receipts[0]?.status).toBe('UNAVAILABLE')
  expect(receipts[0]?.vetoed).toBe(false)

  const budgets: number[] = []
  const delayed = Layer.succeed(JevClient, {
    evaluate: (_request, budgetMs) =>
      Effect.sync(() => budgets.push(budgetMs)).pipe(
        Effect.andThen(Effect.sleep(6_000)),
        Effect.andThen(Effect.fail(new JevError({ failure: JevFailure.Transport, message: 'provider unavailable' }))),
      ),
  })
  const timed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const vetoes = yield* evaluateCatalystVetos({
          candidates: Array.from({ length: 8 }, () => candidate),
          vetoThreshold: 0.85,
          budgetMs: 10_000,
          recordedAt: observedAt,
        }).pipe(Effect.forkScoped)
        yield* TestClock.adjust(10_000)
        return yield* Fiber.join(vetoes)
      }),
    ).pipe(Effect.provide(Layer.mergeAll(delayed, TestClock.layer()))),
  )
  expect(budgets).toEqual([10_000, 10_000, 10_000, 10_000, 4_000, 4_000, 4_000, 4_000])
  expect(timed.map(({ status }) => status)).toEqual(Array.from({ length: 8 }, () => 'UNAVAILABLE'))

  // Full runtime evaluation with catalystVeto.enabled === false makes zero JevClient calls
  // (preventing un-journaled paid API traffic) and selects the deterministic 4-leg basket.
  let jevCalls = 0
  const countingJevClient = Layer.succeed(JevClient, {
    evaluate: (req) => {
      jevCalls += 1
      const isCohr = JSON.stringify(req).includes('"COHR"')
      const inference: JevInference = {
        requestHash: '7'.repeat(64),
        responseHash: '8'.repeat(64),
        startedAt: observedAt,
        completedAt: observedAt,
        response: {
          model: policy.catalystVeto.model,
          answers: {
            catalyst_dislocation_veto: {
              type: 'noul',
              noul: isCohr ? 0.92 : 0.12,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }
      return Effect.succeed(inference)
    },
  })
  const evaluated = await Effect.runPromise(
    TestClock.setTime(Date.parse(observedAt)).pipe(
      Effect.andThen(
        evaluateIntradayAlphaFromSnapshot({
          observation: {
            cycleId,
            authorityGenerationHash,
            protocol,
            portfolio,
            equityShortEligibility: eligibility,
          },
          rangeEndAt,
          loadSnapshot: Effect.succeed(snapshot),
          policy,
          admissionExpiresAt: Date.parse(observedAt) + 60_000,
        }),
      ),
      Effect.provide(Layer.mergeAll(countingJevClient, obsStore, testTrailingBaselineLayer, TestClock.layer())),
    ),
  )
  expect(recorded.length).toBe(1)
  expect(jevCalls).toBe(0)
  expect(evaluated.decision.selectedSymbols).toEqual(['COHR', 'LITE', 'MU', 'SNDK'])
  expect(evaluated.decision.evidence.catalystVetos).toEqual([])

  middayCompleted = true
  const repeated = await Effect.runPromise(
    TestClock.setTime(Date.parse(observedAt)).pipe(
      Effect.andThen(
        evaluateIntradayAlphaFromSnapshot({
          observation: { cycleId, authorityGenerationHash, protocol, portfolio, equityShortEligibility: eligibility },
          rangeEndAt,
          loadSnapshot: Effect.succeed(snapshot),
          policy,
          admissionExpiresAt: Date.parse(observedAt) + 60_000,
        }),
      ),
      Effect.provide(Layer.mergeAll(countingJevClient, obsStore, testTrailingBaselineLayer, TestClock.layer())),
    ),
  )
  expect(jevCalls).toBe(0)
  expect(repeated.decision.evidence.middayReversionCompleted).toBe(true)
  expect(repeated.decision.selectedSymbols).toEqual([])
})

test('multi-position (2L + 2S) JevPortfolio validates 4 legs, partial early leg close, and per-symbol MaximumHold exit', () => {
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    spyProfile: { basePrice: 550, endReturnBps: 0 },
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -350 },
      LITE: { basePrice: 90, endReturnBps: -280 },
      SNDK: { basePrice: 60, endReturnBps: 340 },
      MU: { basePrice: 80, endReturnBps: 250 },
    },
  })
  const flatPortfolio = makeFlatPortfolio(observedAt)
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio: flatPortfolio,
      snapshot,
      trailingBaseline: testTrailingBaseline,
      equityShortEligibility: makeShortEligibility(intradayAlphaCandidateSymbols, observedAt),
    }),
  )
  const target = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: [],
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )

  // Construct a reconciled MANAGE portfolio holding 3 of the 4 legs (1 leg SNDK already closed via native profit target)
  const fillTime = observedAt
  const entryIntentIds = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)]
  const fills: Fill[] = [
    {
      schemaVersion: 'bayn.fill.v2',
      accountId,
      fillId: 'f1',
      brokerOrderId: 'o1',
      clientOrderId: 'c1',
      intentId: entryIntentIds[0],
      symbol: 'COHR',
      side: OrderSide.Buy,
      quantityAtoms: '100000000000', // 100 sh
      priceAtoms: '96500000000',
      feeMicros: '0',
      occurredAt: fillTime,
    },
    {
      schemaVersion: 'bayn.fill.v2',
      accountId,
      fillId: 'f2',
      brokerOrderId: 'o2',
      clientOrderId: 'c2',
      intentId: entryIntentIds[1],
      symbol: 'LITE',
      side: OrderSide.Buy,
      quantityAtoms: '100000000000',
      priceAtoms: '87480000000',
      feeMicros: '0',
      occurredAt: fillTime,
    },
    {
      schemaVersion: 'bayn.fill.v2',
      accountId,
      fillId: 'f3',
      brokerOrderId: 'o3',
      clientOrderId: 'c3',
      intentId: entryIntentIds[2],
      symbol: 'MU',
      side: OrderSide.Sell,
      quantityAtoms: '100000000000',
      priceAtoms: '82000000000',
      feeMicros: '0',
      occurredAt: fillTime,
    },
  ]
  const checkTime = utcInstantFromEpochMillis(
    Date.parse(fillTime) + target.exitPolicy.maximumHoldingMinutes * 60_000 + 1_000,
  )
  const positions: Position[] = [
    {
      schemaVersion: 'bayn.position.v2',
      accountId,
      symbol: 'COHR',
      quantityAtoms: '100000000000',
      averageEntryPriceMicros: '96500000',
      costBasisMicros: '9650000000',
      marketPriceMicros: '97000000',
      marketValueMicros: '9700000000',
      unrealizedPnlMicros: '50000000',
      observedAt: checkTime,
    },
    {
      schemaVersion: 'bayn.position.v2',
      accountId,
      symbol: 'LITE',
      quantityAtoms: '100000000000',
      averageEntryPriceMicros: '87480000',
      costBasisMicros: '8748000000',
      marketPriceMicros: '88000000',
      marketValueMicros: '8800000000',
      unrealizedPnlMicros: '52000000',
      observedAt: checkTime,
    },
    {
      schemaVersion: 'bayn.position.v2',
      accountId,
      symbol: 'MU',
      quantityAtoms: '-100000000000',
      averageEntryPriceMicros: '82000000',
      costBasisMicros: '-8200000000',
      marketPriceMicros: '81000000',
      marketValueMicros: '-8100000000',
      unrealizedPnlMicros: '100000000',
      observedAt: checkTime,
    },
  ]
  const orders: Order[] = [
    {
      schemaVersion: 'bayn.order.v3',
      accountId,
      brokerOrderId: 'o1',
      clientOrderId: 'c1',
      intentId: entryIntentIds[0],
      symbol: 'COHR',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '100000000000',
      filledQuantityAtoms: '100000000000',
      limitPriceMicros: '96500000',
      status: OrderStatus.Filled,
      observedAt: checkTime,
    },
    {
      schemaVersion: 'bayn.order.v3',
      accountId,
      brokerOrderId: 'o2',
      clientOrderId: 'c2',
      intentId: entryIntentIds[1],
      symbol: 'LITE',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '100000000000',
      filledQuantityAtoms: '100000000000',
      limitPriceMicros: '87480000',
      status: OrderStatus.Filled,
      observedAt: checkTime,
    },
    {
      schemaVersion: 'bayn.order.v3',
      accountId,
      brokerOrderId: 'o3',
      clientOrderId: 'c3',
      intentId: entryIntentIds[2],
      symbol: 'MU',
      side: OrderSide.Sell,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '100000000000',
      filledQuantityAtoms: '100000000000',
      limitPriceMicros: '82000000',
      status: OrderStatus.Filled,
      observedAt: checkTime,
    },
  ]
  const brokerMaterial = {
    account: { ...flatPortfolio.brokerState.account, observedAt: checkTime },
    positions,
    positionsObservedAt: checkTime,
    orders,
    ordersObservedAt: checkTime,
    accountingHash: 'd'.repeat(64),
  }
  const stateHash = Result.getOrThrow(reconciledStateHash(brokerMaterial))
  const recMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [] as const,
    reconciledAt: checkTime,
  }
  const recId = Result.getOrThrow(canonicalHashV1Result(recMaterial))
  const recHash = Result.getOrThrow(canonicalHashV1Result({ ...recMaterial, reconciliationId: recId }))
  const managePortfolio = Result.getOrThrow(
    Schema.decodeUnknownResult(
      JevPortfolioSchema,
      strictParseOptions,
    )({
      purpose: JevPurpose.Manage,
      protectionEvidenceVersion: currentProtectionEvidenceVersion,
      brokerState: {
        ...brokerMaterial,
        unknownOrderCount: 0,
        reconciliation: { ...recMaterial, reconciliationId: recId, contentHash: recHash },
      },
      entryDecisionHash: '9'.repeat(64),
      exitPolicy: target.exitPolicy,
      entryIntentIds,
      protectionIntentIds: [],
      exitRequestedAt: null,
      profitExitRequested: false,
      protectionDisposals: { quantityAtoms: '0', costBasisMicros: '0' },
      entryInventoryDebit: { quantityAtoms: '0', costBasisMicros: '0' },
      entryFills: fills,
    }),
  )

  // Per-symbol MaximumHold exit on Short leg MU succeeds cleanly!
  const muExit = Result.getOrThrow(
    decideJevExit({
      cycleId,
      sessionDate,
      protocol,
      portfolio: managePortfolio,
      observedAt: checkTime,
      symbol: 'MU',
      trigger: { reason: JevExitReason.MaximumHold },
    }),
  )
  expect(muExit.symbols).toEqual(['MU'])
  expect(muExit.reason).toBe(JevExitReason.MaximumHold)
  expect(muExit.targetWeights).toEqual({ MU: 0 })

  // Per-symbol MaximumHold exit on Long leg COHR succeeds independently as well!
  const cohrExit = Result.getOrThrow(
    decideJevExit({
      cycleId,
      sessionDate,
      protocol,
      portfolio: managePortfolio,
      observedAt: checkTime,
      symbol: 'COHR',
      trigger: { reason: JevExitReason.MaximumHold },
    }),
  )
  expect(cohrExit.symbols).toEqual(['COHR'])
  expect(cohrExit.reason).toBe(JevExitReason.MaximumHold)
  expect(cohrExit.targetWeights).toEqual({ COHR: 0 })

  // And before MaximumHold due time, decideJevPositionHold holds cleanly without exiting!
  const earlyCheckTime = utcInstantFromEpochMillis(Date.parse(fillTime) + 10_000)
  const earlyPositions = positions.map((p) => ({ ...p, observedAt: earlyCheckTime }))
  const earlyOrders = orders.map((o) => ({ ...o, observedAt: earlyCheckTime }))
  const earlyBrokerMaterial = {
    account: { ...flatPortfolio.brokerState.account, observedAt: earlyCheckTime },
    positions: earlyPositions,
    positionsObservedAt: earlyCheckTime,
    orders: earlyOrders,
    ordersObservedAt: earlyCheckTime,
    accountingHash: 'd'.repeat(64),
  }
  const earlyStateHash = Result.getOrThrow(reconciledStateHash(earlyBrokerMaterial))
  const earlyRecMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: earlyStateHash,
    observedHash: earlyStateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [] as const,
    reconciledAt: earlyCheckTime,
  }
  const earlyRecId = Result.getOrThrow(canonicalHashV1Result(earlyRecMaterial))
  const earlyRecHash = Result.getOrThrow(canonicalHashV1Result({ ...earlyRecMaterial, reconciliationId: earlyRecId }))
  const earlyPortfolio = Result.getOrThrow(
    Schema.decodeUnknownResult(
      JevPortfolioSchema,
      strictParseOptions,
    )({
      purpose: JevPurpose.Manage,
      protectionEvidenceVersion: currentProtectionEvidenceVersion,
      brokerState: {
        ...earlyBrokerMaterial,
        unknownOrderCount: 0,
        reconciliation: { ...earlyRecMaterial, reconciliationId: earlyRecId, contentHash: earlyRecHash },
      },
      entryDecisionHash: '9'.repeat(64),
      exitPolicy: target.exitPolicy,
      entryIntentIds,
      protectionIntentIds: [],
      exitRequestedAt: null,
      profitExitRequested: false,
      protectionDisposals: { quantityAtoms: '0', costBasisMicros: '0' },
      entryInventoryDebit: { quantityAtoms: '0', costBasisMicros: '0' },
      entryFills: fills,
    }),
  )
  // Before MaximumHold due time, decideJevExit refuses premature MaximumHold exit on COHR!
  const prematureExit = decideJevExit({
    cycleId,
    sessionDate,
    protocol,
    portfolio: earlyPortfolio,
    observedAt: earlyCheckTime,
    symbol: 'COHR',
    trigger: { reason: JevExitReason.MaximumHold },
  })
  expect(Result.isFailure(prematureExit)).toBe(true)
})

test('intraday alpha policy identity and native startup preparation bind distinct protocol hash', () => {
  const identity = Result.getOrThrow(intradayAlphaStrategyIdentity(policy))
  expect(identity.strategy.parameterSchemaVersion).toBe('bayn.intraday-alpha-policy.v2')
  expect(identity.strategy.parameterHash).toBe(Result.getOrThrow(canonicalHashV1Result(policy)))
  expect(Result.isFailure(decodeIntradayAlphaPolicy({ ...policy, candidateSymbols: ['AAPL'] }))).toBe(true)

  const strategy = makeIntradayAlphaRuntime(policy, { ...fixtureRuntime.provenance, strategy: identity.strategy })
  const prepared = Result.getOrThrow(
    prepareObserveStartup({
      strategy,
      accountId,
      authorityGenerationHash,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
    }),
  )
  expect(prepared.strategyProtocolHash).toBe(identity.protocolHash)
})

test('durable execution decision validation reproduces bar-close alpha pricing, 10bp slippage, uncapped short sizing, and regular-session midday close window', async () => {
  const { document, cycle, rangeEndAt, jevCalls } = await nativeAlphaDecisionFixture()

  expect(jevCalls).toBe(0)
  expect(document.entryLimitSlippageBps).toBe(10)
  expect(document.targetPlan.status).toBe(TargetPlanStatus.Planned)
  expect(document.targetPlan.intentTargets.map((intent) => intent.symbol).toSorted()).toEqual([
    'COHR',
    'LITE',
    'MU',
    'SNDK',
  ])
  for (const shortSymbol of ['MU', 'SNDK']) {
    const shortIntent = document.targetPlan.intentTargets.find((intent) => intent.symbol === shortSymbol)
    // Short quantity is NOT capped at the 1-share displayed IEX bidSize.
    expect(BigInt(shortIntent?.quantityAtoms ?? '0')).toBeGreaterThan(100_000_000_000n)
  }
  expect(Result.isSuccess(decodeExecutionDecisionDocument(document))).toBe(true)

  // A real strictly decoded native decision remains visible before any execution evidence exists.
  // The projection must not mistake bound intent identities for persisted/submitted orders.
  const alphaRow = Schema.decodeUnknownSync(
    AlphaDecisionJsonRow,
    strictParseOptions,
  )({
    cycle_id: document.bindings.cycleId,
    decision_hash: document.contentHash,
    document_json: JSON.stringify(document),
    created_at: new Date(document.createdAt),
    account_id: document.bindings.accountId,
    authority_generation_hash: document.bindings.authorityGenerationHash,
    qualification_run_id: document.bindings.qualificationRunId,
    strategy_protocol_hash: document.bindings.strategyProtocolHash,
    risk_policy_hash: document.bindings.policyHash,
    session_date: sessionDate,
    cycle_state: CycleState.Active,
    terminal_at: null,
    generation_activated_at: new Date(Date.parse(document.createdAt) - 1_000),
    reconciled_at: new Date(Date.parse(document.createdAt) + 2_000),
    execution_evidence_in_scope: false,
    qualification_build: null,
    activation_build: null,
  })
  const alphaProjection = verifyAlphaDecisionJson(alphaRow)
  expect(alphaProjection.unverifiedAlphaDecisionHashes).toEqual([])
  expect(alphaProjection.alphaDecisions).toHaveLength(1)
  const alphaEvidence = alphaProjection.alphaDecisions[0]!
  expect(alphaEvidence.selectedSymbols.toSorted()).toEqual(['COHR', 'LITE', 'MU', 'SNDK'])
  expect(alphaEvidence.targetPlan.legs.map((leg) => leg.intentId)).toEqual([...document.orderedIntentIds])
  expect(alphaEvidence.targetPlan.legs.map((leg) => leg.quantityAtoms)).toEqual(
    document.targetPlan.intentTargets.map((leg) => leg.quantityAtoms),
  )
  expect(alphaEvidence.cycleState).toBe(CycleState.Active)
  expect(alphaEvidence.executionEvidenceInScope).toBe(false)
  expect(alphaEvidence.executingBuild).toBeNull()
  expect(alphaEvidence.strategyProtocolHash).toBe(document.bindings.strategyProtocolHash)
  expect(alphaEvidence.riskPolicyHash).toBe(document.bindings.policyHash)
  for (const state of [CycleState.Pending, CycleState.Blocked, CycleState.NoTrade]) {
    const projected = verifyAlphaDecisionJson({ ...alphaRow, cycle_state: state })
    expect(projected.alphaDecisions[0]?.cycleState).toBe(state)
    expect(projected.alphaDecisions[0]?.targetPlan).toEqual(alphaEvidence.targetPlan)
    expect(projected.alphaDecisions[0]?.executionEvidenceInScope).toBe(false)
  }
  const completedProjection = verifyAlphaDecisionJson({
    ...alphaRow,
    cycle_state: CycleState.Completed,
    terminal_at: new Date(Date.parse(document.createdAt) + 1_000),
    execution_evidence_in_scope: true,
  })
  expect(completedProjection.alphaDecisions[0]?.executionEvidenceInScope).toBe(true)
  expect(completedProjection.alphaDecisions[0]?.targetPlan).toEqual(alphaEvidence.targetPlan)
  expect(verifyReportJob({ id: 1, input: { task: ReportVerificationTask.AlphaDecision, row: alphaRow } })).toEqual({
    id: 1,
    outcome: 'ALPHA_DECISION',
    value: alphaProjection,
  })
  expect(
    await Effect.runPromise(
      readPerformanceAlphaDecisionCursor((consume) => consume(alphaRow).pipe(Effect.as(undefined))),
    ),
  ).toEqual({
    alphaDecisions: [...alphaProjection.alphaDecisions],
    unverifiedAlphaDecisionHashes: [...alphaProjection.unverifiedAlphaDecisionHashes],
  })
  for (const invalid of [
    { ...alphaRow, decision_hash: 'f'.repeat(64) },
    { ...alphaRow, cycle_id: 'f'.repeat(64) },
    { ...alphaRow, account_id: 'foreign-account' },
    { ...alphaRow, authority_generation_hash: 'f'.repeat(64) },
    { ...alphaRow, qualification_run_id: 'f'.repeat(64) },
    { ...alphaRow, strategy_protocol_hash: 'f'.repeat(64) },
    { ...alphaRow, risk_policy_hash: 'f'.repeat(64) },
    { ...alphaRow, session_date: Schema.decodeUnknownSync(IsoDateSchema)('2026-09-05') },
    { ...alphaRow, created_at: new Date(Date.parse(document.createdAt) + 1) },
    { ...alphaRow, generation_activated_at: new Date(Date.parse(document.createdAt) + 1) },
    { ...alphaRow, reconciled_at: new Date(Date.parse(document.createdAt) - 1) },
    { ...alphaRow, execution_evidence_in_scope: true },
    { ...alphaRow, cycle_state: CycleState.Completed, execution_evidence_in_scope: true },
    { ...alphaRow, document_json: JSON.stringify({ ...document, dispatchable: !document.dispatchable }) },
  ])
    expect(verifyAlphaDecisionJson(invalid)).toEqual({
      alphaDecisions: [],
      unverifiedAlphaDecisionHashes: [invalid.decision_hash],
    })

  // Tampering slippage above policy (11bp) or reference price away from bar close fails durable validation.
  const { contentHash: _ignored, ...docMaterial } = document
  const badSlippage = { ...docMaterial, entryLimitSlippageBps: 11 }
  expect(
    Result.isFailure(
      decodeExecutionDecisionDocument({
        ...badSlippage,
        contentHash: Result.getOrThrow(canonicalHashV1Result(badSlippage)),
      }),
    ),
  ).toBe(true)

  const tamperedPrices = {
    ...docMaterial,
    plannerInput:
      docMaterial.plannerInput === undefined
        ? undefined
        : {
            ...docMaterial.plannerInput,
            referencePrices: {
              ...docMaterial.plannerInput.referencePrices,
              askPriceMicros: {
                ...docMaterial.plannerInput.referencePrices.askPriceMicros,
                COHR: '999000000',
              },
              priceMicros: {
                ...docMaterial.plannerInput.referencePrices.priceMicros,
                COHR: '999000000',
              },
            },
          },
  }
  expect(
    Result.isFailure(
      decodeExecutionDecisionDocument({
        ...tamperedPrices,
        contentHash: Result.getOrThrow(canonicalHashV1Result(tamperedPrices)),
      }),
    ),
  ).toBe(true)

  // Regular-session midday flatten deadline must start at 15:55 EDT (19:55Z) and expire at 16:00 EDT (20:00Z),
  // NOT 16:55 EDT / 17:00 EDT from the extended 08:00-17:00 data session.
  expect(cycle.window.executionCloseAt).toBe('2026-09-04T21:00:00.000Z')
  const regularCloseWindow = await Effect.runPromise(
    closeWindowForCycle(cycle, document, policy.sharedProtocol, '2026-09-04T19:55:00.000Z'),
  )
  expect(regularCloseWindow).toEqual({
    startAt: '2026-09-04T19:55:00.000Z',
    submitCutoffAt: '2026-09-04T20:00:00.000Z',
    expiresAt: '2026-09-04T20:00:00.000Z',
  })

  // Half-day regular session (09:30-13:00 EDT inside 08:00-14:00 EDT extended calendar) flattens at 12:55 EDT.
  const halfDayCalendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      [{ session_open: '0800', session_close: '1400', date: '2026-09-04', open: '09:30', close: '13:00' }],
      { start: '2026-09-04', end: '2026-09-04' },
    ),
  )
  expect(document.executionSession).toBeDefined()
  const halfDayDoc = {
    ...document,
    executionSession: {
      ...document.executionSession!,
      calendar: {
        ...halfDayCalendar,
        requestedRange: { start: sessionDate, end: sessionDate },
        sessions: halfDayCalendar.sessions.map((entry) => ({ ...entry, date: sessionDate })),
        providerSessions: halfDayCalendar.providerSessions.map((entry) => ({ ...entry, date: sessionDate })),
      },
    },
  }
  const halfDayCloseWindow = await Effect.runPromise(
    closeWindowForCycle(cycle, halfDayDoc, policy.sharedProtocol, '2026-09-04T16:55:00.000Z'),
  )
  expect(halfDayCloseWindow).toEqual({
    startAt: '2026-09-04T16:55:00.000Z',
    submitCutoffAt: '2026-09-04T17:00:00.000Z',
    expiresAt: '2026-09-04T17:00:00.000Z',
  })
  expect(rangeEndAt).toBe('2026-09-04T15:31:00.000Z')
})

test('Engine 3 Noise Area Trend triggers on QQQ & SMH at top-of-hour checkpoints with inverse-ATR sizing, 1.5xATR stop, and concurrent disjoint Midday planning', () => {
  // 1) Engine 3 at elapsed = 31 (10:00 ET bar completed -> rangeEnd 10:01 ET)
  const { snapshot: zabSnapshot, observedAt: zabObservedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 31,
    spyProfile: { basePrice: 550, endReturnBps: 50 },
    profiles: {
      // prevClose=500, open=500, avgSwing[31]=0.004 -> UB=502.00; latestClose=504.5 > UB & > VWAP -> LONG
      QQQ: { basePrice: 500, endReturnBps: 90, overrideLatestClose: 504.5 },
      // prevClose=250, open=250, avgSwing[31]=0.006 -> LB=248.50; latestClose=246.0 < LB & < VWAP -> SHORT
      SMH: { basePrice: 250, endReturnBps: -160, overrideLatestClose: 246.0 },
    },
  })
  const flatPortfolio = makeFlatPortfolio(zabObservedAt, '100000000000', '400000000000')
  const zabEligibility = makeShortEligibility(intradayAlphaCandidateSymbols, zabObservedAt)
  const zabOwned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio: flatPortfolio,
      snapshot: zabSnapshot,
      trailingBaseline: testTrailingBaseline,
      equityShortEligibility: zabEligibility,
    }),
  )
  const zabTarget = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: zabOwned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: [],
        catalystVetos: [],
        decidedAt: zabObservedAt,
      },
      policy,
    ),
  )
  expect(zabTarget.phase).toBe(IntradayAlphaPhase.NoiseAreaTrend)
  expect(zabTarget.reason).toBe(IntradayAlphaDecisionReason.SelectedNoiseArea)
  expect(zabTarget.selectedSymbols).toEqual(['QQQ', 'SMH'])
  // Inverse-ATR weights (QQQ atr=1.4% vs SMH atr=2.4%) inside 50% sleeve clamped to [0.15, 0.32]
  expect(zabTarget.targetWeights['QQQ']).toBeCloseTo(0.3158, 3)
  expect(zabTarget.targetWeights['SMH']).toBeCloseTo(-0.1842, 3)
  expect(zabTarget.exitPolicy.plans['QQQ']?.schemaVersion).toBe('bayn.intraday-alpha-long-funded-exit-plan.v1')
  expect(zabTarget.exitPolicy.plans['SMH']?.schemaVersion).toBe('bayn.intraday-alpha-short-funded-exit-plan.v1')

  // 2) Concurrent disjoint entry: while SMH is co-held with a protective exit order, Midday Reversion
  // enters 2L + 2S on COHR/LITE/MU/SNDK via concurrentDisjointPositions + executionPurpose: 'disjoint-entry'!
  const { snapshot: mrSnapshot, observedAt: mrObservedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    spyProfile: { basePrice: 550, endReturnBps: 5 },
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -380 },
      LITE: { basePrice: 90, endReturnBps: -290 },
      SNDK: { basePrice: 60, endReturnBps: 360 },
      MU: { basePrice: 80, endReturnBps: 270 },
    },
  })
  const smhPosition: Position = {
    schemaVersion: 'bayn.position.v2',
    accountId,
    symbol: 'SMH',
    quantityAtoms: '-75000000000', // -75 shares short (~$18,450)
    averageEntryPriceMicros: '246000000',
    costBasisMicros: '-18450000000',
    marketPriceMicros: '244000000',
    marketValueMicros: '-18300000000',
    unrealizedPnlMicros: '150000000',
    observedAt: mrObservedAt,
  }
  const smhProtectionOrder: Order = {
    schemaVersion: 'bayn.order.v3',
    accountId,
    brokerOrderId: 'smh-prot-1',
    clientOrderId: 'smh-prot-c1',
    intentId: 'f'.repeat(64),
    symbol: 'SMH',
    side: OrderSide.Buy,
    orderType: OrderType.StopLimit,
    timeInForce: TimeInForce.Day,
    quantityAtoms: '75000000000',
    filledQuantityAtoms: '0',
    stopPriceMicros: '254860000',
    limitPriceMicros: '255110000',
    status: OrderStatus.New,
    observedAt: mrObservedAt,
  }
  const coHeldMaterial = {
    account: {
      schemaVersion: 'bayn.paper-account-snapshot.v2' as const,
      accountId,
      status: AccountStatus.Active,
      currency: 'USD' as const,
      cashMicros: '100000000000',
      buyingPowerMicros: '381550000000',
      equityMicros: '100000000000',
      cryptoFeeTier: null,
      observedAt: mrObservedAt,
    },
    positions: [smhPosition],
    positionsObservedAt: mrObservedAt,
    orders: [smhProtectionOrder],
    ordersObservedAt: mrObservedAt,
    accountingHash: 'd'.repeat(64),
  }
  const coHeldHash = Result.getOrThrow(reconciledStateHash(coHeldMaterial))
  const coHeldRecMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: coHeldHash,
    observedHash: coHeldHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [] as const,
    reconciledAt: mrObservedAt,
  }
  const coHeldRecId = Result.getOrThrow(canonicalHashV1Result(coHeldRecMaterial))
  const coHeldRecHash = Result.getOrThrow(
    canonicalHashV1Result({ ...coHeldRecMaterial, reconciliationId: coHeldRecId }),
  )
  const coHeldBrokerState = {
    ...coHeldMaterial,
    unknownOrderCount: 0,
    reconciliation: { ...coHeldRecMaterial, reconciliationId: coHeldRecId, contentHash: coHeldRecHash },
  }

  // Strictly flat entry rejects co-held SMH, whereas concurrentDisjointPositions: true admits it!
  expect(Result.isFailure(decodeJevPortfolio({ purpose: JevPurpose.Entry, brokerState: coHeldBrokerState }))).toBe(true)
  const disjointEntryPortfolio = Result.getOrThrow(
    decodeJevPortfolio({
      purpose: JevPurpose.Entry,
      concurrentDisjointPositions: true,
      brokerState: coHeldBrokerState,
    }),
  )
  const mrEligibility = makeShortEligibility(intradayAlphaCandidateSymbols, mrObservedAt)
  const mrOwned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio: disjointEntryPortfolio,
      snapshot: mrSnapshot,
      trailingBaseline: testTrailingBaseline,
      equityShortEligibility: mrEligibility,
    }),
  )
  const mrTarget = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: mrOwned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: ['SMH'],
        catalystVetos: [],
        decidedAt: mrObservedAt,
      },
      policy,
    ),
  )
  expect(mrTarget.selectedSymbols).toEqual(['COHR', 'LITE', 'MU', 'SNDK'])

  const compiledMr = Result.getOrThrow(compileJevEntry(mrTarget, mrSnapshot, mrSnapshot))
  const refMaterial = {
    schemaVersion: 'bayn.intraday-snapshot-reference-prices.v1' as const,
    snapshotId: mrSnapshot.manifest.snapshotId,
    snapshotContentHash: mrSnapshot.manifest.contentHash,
    priceReference: 'verified-adverse-quote-boundary' as const,
    signalDate: sessionDate,
    observedAt: mrSnapshot.manifest.observedAt,
    priceMicros: compiledMr.priceMicros,
    bidPriceMicros: compiledMr.bidPriceMicros ?? compiledMr.priceMicros,
    askPriceMicros: compiledMr.askPriceMicros ?? compiledMr.priceMicros,
  }
  const refHash = Result.getOrThrow(canonicalHashV1Result(refMaterial))
  const disjointPlan = Result.getOrThrow(
    planTargets({
      schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
      strategyName: 'jev',
      cycleId,
      decisionHash: '3'.repeat(64),
      policyHash: '4'.repeat(64),
      accountId,
      signalDate: sessionDate,
      targetWeights: compiledMr.planningTargetWeights ?? mrTarget.targetWeights,
      referencePrices: { ...refMaterial, contentHash: refHash },
      brokerState: coHeldBrokerState,
      precision: protocol.executionModel.precision,
      allocationCapitalMicros: coHeldBrokerState.account.equityMicros,
      maximumInputAgeMs: 60_000,
      submissionCutoffAt: utcInstantFromEpochMillis(Date.parse(mrObservedAt) + 60_000),
      observedAt: mrObservedAt,
      executionTerms: {
        executionPurpose: 'disjoint-entry',
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        priceReference: 'verified-adverse-quote-boundary',
        snapshotId: mrSnapshot.manifest.snapshotId,
        snapshotContentHash: mrSnapshot.manifest.contentHash,
        maximumBuyQuantityAtoms: compiledMr.maximumBuyQuantityAtoms,
        maximumSellQuantityAtoms: compiledMr.maximumSellQuantityAtoms,
        equityShortEntries: Object.fromEntries(
          ['MU', 'SNDK'].map((symbol) => [symbol, mrEligibility[symbol]]).filter((entry) => entry[1] !== undefined),
        ),
      },
    }),
  )
  expect(disjointPlan.status).toBe(TargetPlanStatus.Planned)
  expect(disjointPlan.intentTargets.map((intent) => intent.symbol).toSorted()).toEqual(['COHR', 'LITE', 'MU', 'SNDK'])

  // Same-symbol collision fails closed when a disjoint-entry target overlaps already-held SMH!
  const collidingPlan = planTargets({
    schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
    strategyName: 'jev',
    cycleId,
    decisionHash: '3'.repeat(64),
    policyHash: '4'.repeat(64),
    accountId,
    signalDate: sessionDate,
    targetWeights: { SMH: 0.2 },
    referencePrices: {
      ...refMaterial,
      priceMicros: { SMH: '244000000' },
      bidPriceMicros: { SMH: '243900000' },
      askPriceMicros: { SMH: '244100000' },
      contentHash: Result.getOrThrow(
        canonicalHashV1Result({
          ...refMaterial,
          priceMicros: { SMH: '244000000' },
          bidPriceMicros: { SMH: '243900000' },
          askPriceMicros: { SMH: '244100000' },
        }),
      ),
    },
    brokerState: coHeldBrokerState,
    precision: protocol.executionModel.precision,
    allocationCapitalMicros: coHeldBrokerState.account.equityMicros,
    maximumInputAgeMs: 60_000,
    submissionCutoffAt: utcInstantFromEpochMillis(Date.parse(mrObservedAt) + 60_000),
    observedAt: mrObservedAt,
    executionTerms: {
      executionPurpose: 'disjoint-entry',
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      priceReference: 'verified-adverse-quote-boundary',
      snapshotId: mrSnapshot.manifest.snapshotId,
      snapshotContentHash: mrSnapshot.manifest.contentHash,
    },
  })
  expect(Result.isFailure(collidingPlan)).toBe(true)
})

test('concurrent ORB position management scopes to owned TSLA even when co-held QQQ sorts alphabetically first, and disjoint mandate bounds independent net exposure', () => {
  // 1) Disjoint mandate allocation bounds longs & shorts independently against worst-case net exposure
  // ($70k co-held long + $100k net cap + 2L/2S basket (+0.36 / -0.36) -> $30k long headroom -> $83,333.33 cap).
  const allocation = Result.getOrThrow(
    executionMandateAllocationCapitalMicros({
      accountEquityMicros: 100_000_000_000n,
      dailyTradedNotionalMicros: 0n,
      maxGrossExposureMicros: 180_000_000_000n,
      maxNetExposureMicros: 100_000_000_000n,
      maxDailyTradedNotionalMicros: null,
      maxAdverseSlippageBps: 10n,
      targetWeights: { COHR: 0.18, LITE: 0.18, MU: 0.18, SNDK: 0.18 },
      signedTargetWeights: { COHR: 0.18, LITE: 0.18, MU: -0.18, SNDK: -0.18 },
      disjointEntry: true,
      positions: [{ symbol: 'QQQ', quantityAtoms: '140000000000', marketValueMicros: '70000000000' }],
      openOrders: [
        // Canceled (OrderStatus.Canceled === 'CANCELED') orders must NOT consume fictitious net headroom!
        {
          symbol: 'QQQ',
          side: OrderSide.Buy,
          status: OrderStatus.Canceled,
          quantityAtoms: '100000000000',
          filledQuantityAtoms: '0',
          limitPriceMicros: '500000000',
          brokerOrderId: 'canceled-order-1',
        },
      ],
      referencePriceMicros: { COHR: '100000000', LITE: '90000000', MU: '80000000', SNDK: '60000000' },
    }),
  )
  // 30_000_000_000 / 0.36 = 83_333_333_333 micros -> worst-case 70k + 30k = 100k <= maxNetExposure!
  expect(allocation).toBe(83_333_333_333n)

  // 2) ORB TSLA Manage portfolio with co-held QQQ sorting alphabetically BEFORE TSLA:
  // both implicit (omitted symbol) and explicit symbol='TSLA' exit evaluation target TSLA, never QQQ!
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 36,
    spyProfile: { basePrice: 550, endReturnBps: 60 },
    profiles: {
      TSLA: {
        basePrice: 250,
        endReturnBps: 80,
        openingRangeHigh: 251.0,
        openingRangeLow: 249.0,
        overridePrevClose: 250.9,
        overrideLatestClose: 252.5,
      },
    },
  })
  const flat = makeFlatPortfolio(observedAt)
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio: flat,
      snapshot,
      trailingBaseline: testTrailingBaseline,
      equityShortEligibility: makeShortEligibility(intradayAlphaCandidateSymbols, observedAt),
    }),
  )
  const orbTarget = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: ['QQQ'],
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )
  expect(orbTarget.selectedSymbols).toEqual(['TSLA'])

  const tslaEntryIntentId = 'a'.repeat(64)
  const checkTime = utcInstantFromEpochMillis(
    Date.parse(observedAt) + orbTarget.exitPolicy.maximumHoldingMinutes * 60_000 + 1_000,
  )
  const qqqCoHeld: Position = {
    schemaVersion: 'bayn.position.v2',
    accountId,
    symbol: 'QQQ', // sorts BEFORE TSLA!
    quantityAtoms: '50000000000',
    averageEntryPriceMicros: '500000000',
    costBasisMicros: '25000000000',
    marketPriceMicros: '504000000',
    marketValueMicros: '25200000000',
    unrealizedPnlMicros: '200000000',
    observedAt: checkTime,
  }
  const tslaOwned: Position = {
    schemaVersion: 'bayn.position.v2',
    accountId,
    symbol: 'TSLA',
    quantityAtoms: '100000000000',
    averageEntryPriceMicros: '252500000',
    costBasisMicros: '25250000000',
    marketPriceMicros: '253000000',
    marketValueMicros: '25300000000',
    unrealizedPnlMicros: '50000000',
    observedAt: checkTime,
  }
  const tslaFill: Fill = {
    schemaVersion: 'bayn.fill.v2',
    accountId,
    fillId: 'tsla-f1',
    brokerOrderId: 'tsla-o1',
    clientOrderId: 'tsla-c1',
    intentId: tslaEntryIntentId,
    symbol: 'TSLA',
    side: OrderSide.Buy,
    quantityAtoms: '100000000000',
    priceAtoms: '252500000000',
    feeMicros: '0',
    occurredAt: observedAt,
  }
  const tslaOrder: Order = {
    schemaVersion: 'bayn.order.v3',
    accountId,
    brokerOrderId: 'tsla-o1',
    clientOrderId: 'tsla-c1',
    intentId: tslaEntryIntentId,
    symbol: 'TSLA',
    side: OrderSide.Buy,
    orderType: OrderType.Limit,
    timeInForce: TimeInForce.Day,
    quantityAtoms: '100000000000',
    filledQuantityAtoms: '100000000000',
    limitPriceMicros: '252500000',
    status: OrderStatus.Filled,
    observedAt: checkTime,
  }
  const brokerMaterial = {
    account: { ...flat.brokerState.account, observedAt: checkTime },
    positions: [qqqCoHeld, tslaOwned], // QQQ explicitly precedes TSLA!
    positionsObservedAt: checkTime,
    orders: [tslaOrder],
    ordersObservedAt: checkTime,
    accountingHash: 'd'.repeat(64),
  }
  const stateHash = Result.getOrThrow(reconciledStateHash(brokerMaterial))
  const recMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [] as const,
    reconciledAt: checkTime,
  }
  const recId = Result.getOrThrow(canonicalHashV1Result(recMaterial))
  const recHash = Result.getOrThrow(canonicalHashV1Result({ ...recMaterial, reconciliationId: recId }))
  const managePortfolio = Result.getOrThrow(
    Schema.decodeUnknownResult(
      JevPortfolioSchema,
      strictParseOptions,
    )({
      purpose: JevPurpose.Manage,
      protectionEvidenceVersion: currentProtectionEvidenceVersion,
      brokerState: {
        ...brokerMaterial,
        unknownOrderCount: 0,
        reconciliation: { ...recMaterial, reconciliationId: recId, contentHash: recHash },
      },
      entryDecisionHash: '9'.repeat(64),
      exitPolicy: orbTarget.exitPolicy,
      entryIntentIds: [tslaEntryIntentId],
      protectionIntentIds: [],
      exitRequestedAt: null,
      profitExitRequested: false,
      protectionDisposals: { quantityAtoms: '0', costBasisMicros: '0' },
      entryInventoryDebit: { quantityAtoms: '0', costBasisMicros: '0' },
      entryFills: [tslaFill],
    }),
  )

  // Both omitted symbol and explicit symbol='TSLA' cleanly exit TSLA without tripping on co-held QQQ!
  const implicitExit = Result.getOrThrow(
    decideJevExit({
      cycleId,
      sessionDate,
      protocol,
      portfolio: managePortfolio,
      observedAt: checkTime,
      trigger: { reason: JevExitReason.MaximumHold },
    }),
  )
  expect(implicitExit.symbols).toEqual(['TSLA'])
  const explicitExit = Result.getOrThrow(
    decideJevExit({
      cycleId,
      sessionDate,
      protocol,
      portfolio: managePortfolio,
      observedAt: checkTime,
      symbol: 'TSLA',
      trigger: { reason: JevExitReason.MaximumHold },
    }),
  )
  expect(explicitExit.symbols).toEqual(['TSLA'])
})
