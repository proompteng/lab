import { describe, expect, test } from 'bun:test'
import {
  alignBars,
  canonicalHashV1,
  MICROS,
  referencePriceMicros,
  simulate,
  type EvaluationResult,
  type IsoDate,
  type SimulationTarget,
  validateCandidateDevelopmentAccountingReplay,
} from './test-api'
import { Result } from './test-runtime'
import {
  baselineFixture,
  buildCandidateDevelopmentCommandReport,
  buildFixtureReport,
  commandEvaluationFixture,
  firstDecisionFixture,
  fixtureAccountingStart,
  fixtureExecutionModel,
  fixtureHistorySessions,
  fixtureInputManifest,
  fixtureMarketBars,
  fixtureMarketData,
  fixtureRunId,
  fixtureSessions,
  fixtureSpyClose,
  fixtureStrategyProtocol,
  fixtureStressedRunId,
  makeSignalDecisionFixture,
  reportFixture,
  successOf,
  terminalDecisionFixture,
  zeroPositionFixture,
} from './test-support'

describe('candidate development accounting replay', () => {
  test('requires cash yield before same-session fill and fee evidence', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const insertFeeBeforeYield = (events: EvaluationResult['events'], runId: string): EvaluationResult['events'] => {
      const yieldIndex = events.findIndex((event) => event.kind === 'cash-yield')
      const cashYield = events[yieldIndex]
      if (yieldIndex < 0 || cashYield?.kind !== 'cash-yield') {
        throw new Error('cash-yield fixture must be present')
      }
      const payload = {
        kind: 'fee' as const,
        sessionDate: cashYield.sessionDate,
        commissionMicros: '0',
        secMicros: '0',
        tafMicros: '0',
        catMicros: '0',
        totalMicros: '0',
      }
      const fee = { ...payload, id: canonicalHashV1({ runId, ...payload }) }
      return [...events.slice(0, yieldIndex), fee, ...events.slice(yieldIndex)]
    }

    const baselineWithLateYield = {
      ...baseline,
      events: insertFeeBeforeYield(baseline.events, baseline.runId),
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, baselineWithLateYield),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.cashYield.order',
        expected: 'before every same-session fill and fee',
        observed: { kind: 'fee' },
      },
    })

    const evaluation = commandEvaluationFixture(report, baseline)
    const accounting = {
      ...evaluation.accounting,
      stressedEvents: insertFeeBeforeYield(evaluation.accounting.stressedEvents, evaluation.accounting.stressedRunId),
    }
    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'stressed.cashYield.order',
        expected: 'before every same-session fill and fee',
        observed: { kind: 'fee' },
      },
    })
  })

  test('binds the accounting predecessor to the immediately preceding official session', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)
    const skippedSession = '2019-12-30' as IsoDate
    const accounting = {
      ...evaluation.accounting,
      baselineSimulation: {
        ...evaluation.accounting.baselineSimulation,
        dailyMarks: evaluation.accounting.baselineSimulation.dailyMarks.map((mark, index) =>
          index === 0 ? { ...mark, sessionDate: skippedSession } : mark,
        ),
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.calendar.sessionDate',
        index: 1,
        expected: fixtureAccountingStart,
        observed: fixtureSessions[0],
      },
    })
  })

  test('rejects multiple accounting predecessors before the selected window', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)
    const earlierSession = fixtureHistorySessions.at(-2)
    if (earlierSession === undefined) throw new Error('fixture history requires two predecessor sessions')
    const addEarlierPredecessor = (simulation: EvaluationResult['simulation']) => {
      const predecessor = simulation.dailyMarks[0]
      return {
        ...simulation,
        dailyMarks: [
          {
            ...predecessor,
            sessionDate: earlierSession,
            positions: fixtureStrategyProtocol.universe.map((symbol) => zeroPositionFixture(earlierSession, symbol)),
          },
          ...simulation.dailyMarks,
        ],
      }
    }

    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        {
          ...evaluation,
          accounting: {
            ...evaluation.accounting,
            baselineSimulation: addEarlierPredecessor(evaluation.accounting.baselineSimulation),
          },
        },
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'selected-trace-mismatch',
        field: 'baselineSimulation.predecessorCount',
        expected: 1,
        observed: 2,
      },
    })

    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        {
          ...evaluation,
          accounting: {
            ...evaluation.accounting,
            stressedSimulation: addEarlierPredecessor(evaluation.accounting.stressedSimulation),
          },
        },
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'selected-trace-mismatch',
        field: 'stressedSimulation.predecessorCount',
        expected: 1,
        observed: 2,
      },
    })
  })

  test('rejects every out-of-universe accounting symbol before reconciliation', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const qqqPosition = { ...zeroPositionFixture(fixtureSessions[0]), symbol: 'QQQ' }
    const qqqOrder: EvaluationResult['simulation']['orders'][number] = {
      id: 'd'.repeat(64),
      decisionId: firstDecisionFixture.signal.decisionId,
      sessionDate: fixtureSessions[1],
      symbol: 'QQQ',
      side: 'buy',
      requestedQuantityMicros: '1',
      filledQuantityMicros: '0',
      status: 'rejected',
      rejectionReason: 'zero-after-rounding',
      unfilledRemainder: 'none',
    }
    const qqqFill: Extract<EvaluationResult['events'][number], { readonly kind: 'fill' }> = {
      kind: 'fill',
      id: 'e'.repeat(64),
      orderId: qqqOrder.id,
      decisionId: firstDecisionFixture.signal.decisionId,
      sessionDate: fixtureSessions[1],
      symbol: 'QQQ',
      side: 'buy',
      quantityMicros: '1',
      referencePriceMicros: '1000000',
      priceMicros: '1000000',
      notionalMicros: '1',
      spreadCostMicros: '0',
      slippageCostMicros: '0',
      costBasisMicros: '1',
    }

    const decisionBaseline = {
      ...baseline,
      signalDecisions: baseline.signalDecisions.map((decision) => ({
        ...decision,
        targetWeights: { ...decision.targetWeights, QQQ: 0 },
      })),
      events: baseline.events.map((event) =>
        event.kind === 'decision' ? { ...event, targetWeights: { ...event.targetWeights, QQQ: 0 } } : event,
      ),
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, decisionBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: { field: 'baseline.signalDecisions.targetWeights', observed: 'QQQ' },
    })

    const orderBaseline = {
      ...baseline,
      simulation: { ...baseline.simulation, orders: [qqqOrder] },
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, orderBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'baseline.orders.symbol', observed: 'QQQ' } })

    const fillBaseline = { ...baseline, events: [...baseline.events, qqqFill] }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, fillBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'baseline.events.symbol', observed: 'QQQ' } })

    const positionBaseline = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: baseline.simulation.dailyMarks.map((mark, index) =>
          index === 0 ? { ...mark, positions: [...mark.positions, qqqPosition] } : mark,
        ),
      },
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, positionBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'baseline.positions.symbol', observed: 'QQQ' } })

    const evaluation = commandEvaluationFixture(report, baseline)
    const stressedAccounting = {
      ...evaluation.accounting,
      stressedSimulation: {
        ...evaluation.accounting.stressedSimulation,
        dailyMarks: evaluation.accounting.stressedSimulation.dailyMarks.map((mark, index) =>
          index === 0 ? { ...mark, positions: [...mark.positions, qqqPosition] } : mark,
        ),
      },
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        { ...evaluation, accounting: stressedAccounting },
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'stressed.positions.symbol', observed: 'QQQ' } })
  })

  test('rejects a requested order that a zero-weight decision cannot derive', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const orderPayload = {
      decisionId: firstDecisionFixture.signal.decisionId,
      sessionDate: firstDecisionFixture.signal.executionDate,
      symbol: 'SPY',
      side: 'buy' as const,
      requestedQuantityMicros: '1000000',
      filledQuantityMicros: '0',
      status: 'rejected' as const,
      rejectionReason: 'zero-after-rounding' as const,
      unfilledRemainder: 'canceled' as const,
    }
    const impossibleOrder = {
      ...orderPayload,
      id: canonicalHashV1({ runId: baseline.runId, kind: 'order', ...orderPayload }),
    }
    const baselineWithOrder = {
      ...baseline,
      simulation: { ...baseline.simulation, orders: [impossibleOrder] },
    }

    expect(buildFixtureReport(report, baselineWithOrder)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.replay.orders',
      },
    })
  })

  test('requires canonical fill fee and cash evidence in baseline and stressed replay', () => {
    const sessions = successOf(alignBars(fixtureMarketBars, fixtureStrategyProtocol.universe, fixtureInputManifest))
    const sessionIndexByDate = new Map(sessions.map((session, index) => [session.date, index] as const))
    const startIndex = sessionIndexByDate.get(fixtureSessions[0])
    if (startIndex === undefined) throw new Error('fixture replay start is missing')
    const feeProtocol = {
      ...fixtureStrategyProtocol,
      executionModel: {
        ...fixtureExecutionModel,
        fees: { ...fixtureExecutionModel.fees, commissionBps: 100 },
        cash: { ...fixtureExecutionModel.cash, annualYieldBps: 0 },
      },
    }
    const marketData = {
      witness: fixtureMarketData,
      sessions,
      sessionIndexByDate,
    }
    const decisionFor = (
      runId: string,
      base: typeof firstDecisionFixture.signal,
      weight: number,
    ): EvaluationResult['signalDecisions'][number] => {
      const targetWeights = { SPY: weight }
      const payload = {
        signalDate: base.signalDate,
        executionDate: base.executionDate,
        targetWeights,
      }
      return {
        ...base,
        decisionId: canonicalHashV1({ runId, kind: 'decision', ...payload }),
        exposureScale: weight,
        targetWeights,
        signals: base.signals.map((signal) => ({
          ...signal,
          eligible: weight > 0,
          uncappedWeight: weight,
          cappedWeight: weight,
          targetWeight: weight,
        })),
      }
    }
    const targetFor = (decision: EvaluationResult['signalDecisions'][number]): SimulationTarget => {
      const signalIndex = sessionIndexByDate.get(decision.signalDate)
      const executionIndex = sessionIndexByDate.get(decision.executionDate)
      if (signalIndex === undefined || executionIndex === undefined) {
        throw new Error('fixture replay decision schedule is missing')
      }
      const { decisionId: _, executionDate: __, ...plan } = decision
      return { signalIndex, executionIndex, weights: decision.targetWeights, decision: plan }
    }

    for (const [field, runId, costMultiplierMicros] of [
      ['baseline', fixtureRunId, MICROS],
      ['stressed', fixtureStressedRunId, MICROS * 2n],
    ] as const) {
      const signalDecisions = [
        decisionFor(runId, firstDecisionFixture.signal, 1),
        decisionFor(runId, terminalDecisionFixture.signal, 0),
      ]
      const replay = successOf(
        simulate(sessions, signalDecisions.map(targetFor), startIndex, feeProtocol, costMultiplierMicros, runId, true),
      )
      if (replay.simulation === null) throw new Error('fixture replay simulation is missing')
      expect(replay.events.some((event) => event.kind === 'fill')).toBe(true)
      expect(replay.events.some((event) => event.kind === 'fee' && event.totalMicros !== '0')).toBe(true)
      expect(
        replay.simulation.cashChanges.some(
          (cashChange) => cashChange.sourceKind === 'fee' && cashChange.amountMicros.startsWith('-'),
        ),
      ).toBe(true)
      expect(
        Result.isSuccess(
          validateCandidateDevelopmentAccountingReplay(
            field,
            runId,
            signalDecisions,
            replay.events,
            replay.simulation,
            marketData,
            feeProtocol,
          ),
        ),
      ).toBe(true)

      const withoutFeeEvents = replay.events.filter((event) => event.kind !== 'fee')
      expect(
        validateCandidateDevelopmentAccountingReplay(
          field,
          runId,
          signalDecisions,
          withoutFeeEvents,
          replay.simulation,
          marketData,
          feeProtocol,
        ),
      ).toMatchObject({ failure: { field: `${field}.replay.monetaryEvents` } })

      const withoutFeeCash = {
        ...replay.simulation,
        cashChanges: replay.simulation.cashChanges.filter((cashChange) => cashChange.sourceKind !== 'fee'),
      }
      expect(
        validateCandidateDevelopmentAccountingReplay(
          field,
          runId,
          signalDecisions,
          replay.events,
          withoutFeeCash,
          marketData,
          feeProtocol,
        ),
      ).toMatchObject({ failure: { field: `${field}.replay.cashChanges` } })
    }
  })

  test('requires canonical cash-yield events and cash changes in baseline and stressed replay', () => {
    const sessions = successOf(alignBars(fixtureMarketBars, fixtureStrategyProtocol.universe, fixtureInputManifest))
    const marketData = {
      witness: fixtureMarketData,
      sessions,
      sessionIndexByDate: new Map(sessions.map((session, index) => [session.date, index] as const)),
    }
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)

    for (const [field, runId, signalDecisions, events, simulation] of [
      [
        'baseline',
        evaluation.accounting.runId,
        baseline.signalDecisions,
        evaluation.accounting.events,
        evaluation.accounting.baselineSimulation,
      ],
      [
        'stressed',
        evaluation.accounting.stressedRunId,
        report.doubledCost.stressed.signalDecisions,
        evaluation.accounting.stressedEvents,
        evaluation.accounting.stressedSimulation,
      ],
    ] as const) {
      expect(events.some((event) => event.kind === 'cash-yield')).toBe(true)
      expect(simulation.cashChanges.some((cashChange) => cashChange.sourceKind === 'cash-yield')).toBe(true)
      expect(
        Result.isSuccess(
          validateCandidateDevelopmentAccountingReplay(
            field,
            runId,
            signalDecisions,
            events,
            simulation,
            marketData,
            fixtureStrategyProtocol,
          ),
        ),
      ).toBe(true)

      expect(
        validateCandidateDevelopmentAccountingReplay(
          field,
          runId,
          signalDecisions,
          events.filter((event) => event.kind !== 'cash-yield'),
          simulation,
          marketData,
          fixtureStrategyProtocol,
        ),
      ).toMatchObject({ failure: { field: `${field}.replay.monetaryEvents` } })

      expect(
        validateCandidateDevelopmentAccountingReplay(
          field,
          runId,
          signalDecisions,
          events,
          {
            ...simulation,
            cashChanges: simulation.cashChanges.filter((cashChange) => cashChange.sourceKind !== 'cash-yield'),
          },
          marketData,
          fixtureStrategyProtocol,
        ),
      ).toMatchObject({ failure: { field: `${field}.replay.cashChanges` } })
    }
  })

  test('rejects accounting activity not reproduced by the full deterministic replay', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const preRebalance = makeSignalDecisionFixture(fixtureAccountingStart, fixtureSessions[0])
    const baselineWithPreRebalanceEvent = {
      ...baseline,
      events: [preRebalance.event, ...baseline.events],
    }
    const evaluation = commandEvaluationFixture(report, baselineWithPreRebalanceEvent)
    const extraPlanAccounting = {
      ...evaluation.accounting,
      signalDecisions: [preRebalance.signal, ...evaluation.accounting.signalDecisions],
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        { ...evaluation, accounting: extraPlanAccounting },
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'baseline.signalDecisions' } })

    const orderPayload = {
      decisionId: preRebalance.signal.decisionId,
      sessionDate: fixtureSessions[0],
      symbol: 'SPY',
      side: 'buy' as const,
      requestedQuantityMicros: '1',
      filledQuantityMicros: '0',
      status: 'rejected' as const,
      rejectionReason: 'zero-after-rounding' as const,
      unfilledRemainder: 'none' as const,
    }
    const preRebalanceOrder = {
      ...orderPayload,
      id: canonicalHashV1({ runId: baseline.runId, kind: 'order', ...orderPayload }),
    }
    const baselineWithOrder = {
      ...baseline,
      simulation: { ...baseline.simulation, orders: [preRebalanceOrder] },
    }
    expect(buildFixtureReport(report, baselineWithOrder)).toMatchObject({
      failure: { field: 'baseline.replay.orders' },
    })

    const preRebalancePriceMicros = successOf(
      referencePriceMicros(fixtureSpyClose(fixtureAccountingStart), fixtureExecutionModel),
    ).toString()
    const fillPayload = {
      orderId: preRebalanceOrder.id,
      decisionId: preRebalance.signal.decisionId,
      sessionDate: fixtureAccountingStart,
      symbol: 'SPY',
      side: 'buy' as const,
      quantityMicros: '1',
      referencePriceMicros: preRebalancePriceMicros,
      priceMicros: preRebalancePriceMicros,
      notionalMicros: '1',
      spreadCostMicros: '0',
      slippageCostMicros: '0',
      costBasisMicros: '1',
    }
    const preRebalanceFill = {
      kind: 'fill' as const,
      ...fillPayload,
      id: canonicalHashV1({ runId: baseline.runId, kind: 'fill', ...fillPayload }),
    }
    const baselineWithFill = {
      ...baseline,
      events: [preRebalanceFill, ...baseline.events],
    }
    expect(buildFixtureReport(report, baselineWithFill)).toMatchObject({
      failure: { field: 'baseline.replay.monetaryEvents' },
    })

    const stressedSimulation = {
      ...report.doubledCost.stressed.simulation,
      orders: [
        {
          ...preRebalanceOrder,
          id: canonicalHashV1({
            runId: fixtureStressedRunId,
            kind: 'order',
            ...orderPayload,
          }),
        },
      ],
    }
    const stressedReport = {
      ...report,
      doubledCost: {
        ...report.doubledCost,
        stressed: { ...report.doubledCost.stressed, simulation: stressedSimulation },
      },
    }
    const stressedEvaluationFixture = commandEvaluationFixture(stressedReport, baseline)
    const stressedEvaluation = {
      ...stressedEvaluationFixture,
      accounting: {
        ...stressedEvaluationFixture.accounting,
        stressedSimulation: {
          ...stressedEvaluationFixture.accounting.stressedSimulation,
          orders: stressedSimulation.orders,
        },
      },
    }
    expect(
      buildCandidateDevelopmentCommandReport(stressedReport, stressedEvaluation, fixtureStrategyProtocol),
    ).toMatchObject({ failure: { field: 'stressed.replay.orders' } })
  })
})
