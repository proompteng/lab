import { describe, expect, test } from 'bun:test'
import {
  candidateDevelopmentCommandFailureOutputMaxBytes,
  canonicalHashV1,
  canonicalHashV1Result,
  reconcileMarkedEquity,
  renderCandidateDevelopmentCommandFailure,
  renderCandidateDevelopmentCommandReport,
  type EvaluationResult,
  type IsoDate,
} from './test-api'
import { Result } from './test-runtime'
import {
  baselineFixture,
  buildCandidateDevelopmentCommandReport,
  buildFixtureReport,
  commandEvaluationFixture,
  fixtureExecutionModel,
  fixtureInitialCapitalMicros,
  fixtureStrategyProtocol,
  fullAccountingSimulationFixture,
  reportFixture,
  signalDecisionFixture,
  successOf,
} from './test-support'

describe('candidate development report policy', () => {
  test('bounds and rejects arbitrary, cyclic, deep, secret, path, stack, and nondeterministic details', () => {
    const arbitrary = renderCandidateDevelopmentCommandFailure({
      _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
      cause: {
        token: 'credential-value',
        path: '/workspace/private/module.ts',
        stack: 'Error at /workspace/private/module.ts:1:1',
      },
    })
    expect(JSON.parse(arbitrary)).toEqual({
      schemaVersion: 'bayn.candidate-development-command-failure.v1',
      error: {
        _tag: 'CandidateDevelopmentCommandError',
        failure: {
          _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
          cause: {
            _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
            reason: 'untyped-object',
          },
        },
      },
    })

    const cyclicCause: { _tag: string; stage: string; cause?: unknown } = {
      _tag: 'CandidateDevelopmentCyclicFailure',
      stage: 'development-metrics',
    }
    cyclicCause.cause = cyclicCause
    const cyclic = renderCandidateDevelopmentCommandFailure({
      _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
      cause: cyclicCause,
    })
    expect(JSON.parse(cyclic)).toEqual({
      schemaVersion: 'bayn.candidate-development-command-failure.v1',
      error: {
        _tag: 'CandidateDevelopmentCommandError',
        failure: {
          _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
          cause: {
            _tag: 'CandidateDevelopmentCyclicFailure',
            stage: 'development-metrics',
            cause: {
              _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
              reason: 'cycle',
            },
          },
        },
      },
    })

    let deepCause: unknown = { _tag: 'CandidateDevelopmentTerminalFailure', reason: 'bounded' }
    for (let index = 0; index < 10; index += 1) {
      deepCause = { _tag: `CandidateDevelopmentNestedFailure${index}`, cause: deepCause }
    }
    const deep = renderCandidateDevelopmentCommandFailure({
      _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
      cause: deepCause,
    })
    expect(deep).toContain('"reason":"depth-limit"')
    expect(Buffer.byteLength(deep, 'utf8')).toBeLessThanOrEqual(candidateDevelopmentCommandFailureOutputMaxBytes)

    const tagged = renderCandidateDevelopmentCommandFailure({
      _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
      cause: {
        _tag: 'CandidateDevelopmentTaggedFailure',
        stage: 'development-metrics',
        reason: 'typed-cause',
        secret: 'credential-value',
        token: 'credential-value',
        path: '/workspace/private/module.ts',
        stack: 'Error at /workspace/private/module.ts:1:1',
        sourceURL: '/workspace/private/module.ts',
        timestamp: '2026-07-31T18:00:00.000Z',
        requestId: 'nondeterministic-request-id',
      },
    })
    expect(JSON.parse(tagged)).toEqual({
      schemaVersion: 'bayn.candidate-development-command-failure.v1',
      error: {
        _tag: 'CandidateDevelopmentCommandError',
        failure: {
          _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
          cause: {
            _tag: 'CandidateDevelopmentTaggedFailure',
            stage: 'development-metrics',
            reason: 'typed-cause',
          },
        },
      },
    })
    expect(tagged).not.toContain('credential-value')
    expect(tagged).not.toContain('/workspace/')
    expect(tagged).not.toContain('2026-07-31')
    expect(tagged).not.toContain('nondeterministic-request-id')

    const taggedBinding = renderCandidateDevelopmentCommandFailure({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-program-binding',
      cause: {
        _tag: 'CandidateDevelopmentSourceBindingFailure',
        stage: 'verify-program-binding',
        reason: 'mismatch',
        secret: 'credential-value',
      },
    })
    expect(JSON.parse(taggedBinding)).toEqual({
      schemaVersion: 'bayn.candidate-development-command-failure.v1',
      error: {
        _tag: 'CandidateDevelopmentCommandError',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            _tag: 'CandidateDevelopmentSourceBindingFailure',
            stage: 'verify-program-binding',
            reason: 'mismatch',
          },
        },
      },
    })
    expect(taggedBinding).not.toContain('credential-value')

    const unsafeMismatch = renderCandidateDevelopmentCommandFailure({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-program-binding',
      cause: {
        field: 'artifact.structuralBindings.modulePath',
        expected: 'credential-value',
        observed: '/workspace/private/module.ts',
      },
    })
    expect(JSON.parse(unsafeMismatch)).toEqual({
      schemaVersion: 'bayn.candidate-development-command-failure.v1',
      error: {
        _tag: 'CandidateDevelopmentCommandError',
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: 'artifact.structuralBindings.modulePath',
            expected: {
              _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
              reason: 'unsupported-value',
            },
            observed: {
              _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
              reason: 'unsupported-value',
            },
          },
        },
      },
    })
    expect(unsafeMismatch).not.toContain('credential-value')
    expect(unsafeMismatch).not.toContain('/workspace/')

    const oversizedIndexedField = renderCandidateDevelopmentCommandFailure({
      _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
      reason: 'selected-trace-mismatch',
      index: null,
      field: 'baseline.dailyMarks[1234567]',
      expected: 'a'.repeat(64),
      observed: 'b'.repeat(64),
    })
    expect(JSON.parse(oversizedIndexedField)).toMatchObject({
      error: {
        failure: {
          rejectedFields: ['field'],
          expected: 'a'.repeat(64),
          observed: 'b'.repeat(64),
        },
      },
    })
    expect(oversizedIndexedField).not.toContain('baseline.dailyMarks[1234567]')

    const unsafeTargetWeights = renderCandidateDevelopmentCommandFailure({
      _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
      reason: 'binding-mismatch',
      index: 1,
      field: 'benchmarks.terminalDecision',
      expected: 'all-cash target weights',
      observed: { SPY: 0.5, 'credential-value': 1 },
    })
    expect(JSON.parse(unsafeTargetWeights)).toMatchObject({
      error: {
        failure: {
          observed: {
            _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
            reason: 'unsupported-value',
          },
        },
      },
    })
    expect(unsafeTargetWeights).not.toContain('credential-value')
  })

  test('derives the disposition and hashes the complete governed report', () => {
    const passing = successOf(buildFixtureReport(reportFixture(0.01), baselineFixture()))
    const rejected = successOf(buildFixtureReport(reportFixture(-0.01), baselineFixture()))
    const { contentHash, ...material } = passing

    expect(passing.decision.status).toBe('PASS')
    expect(rejected.decision.status).toBe('HOLD_REJECT')
    expect(passing.decision.gates.map(({ name }) => name)).toContain('annualized_excess_return_lower_bound')
    expect(passing.decision.gates.map(({ name }) => name)).not.toContain('annualized_return_difference_lower_bound')
    expect(contentHash).toBe(successOf(canonicalHashV1Result(material)))
    expect(buildFixtureReport(reportFixture(0.01), baselineFixture())).toEqual(Result.succeed(passing))
    const rendered = renderCandidateDevelopmentCommandReport(passing)
    expect(rendered.endsWith('\n')).toBe(true)
    expect(rendered.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(rendered)).toEqual(passing)
  })

  test('rejects detached doubled-cost summary metrics', () => {
    const baseline = baselineFixture()
    const detached = {
      ...baseline,
      doubleCostStrategy: { ...baseline.doubleCostStrategy, annualizedReturn: 0.5 },
    }

    expect(buildFixtureReport(reportFixture(0.01), detached)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
        series: 'double-cost-series',
        reason: 'metrics-mismatch',
        field: 'annualizedReturn',
        observed: 0.5,
      },
    })
  })

  test('binds the reported doubled-cost daily series to stressed replay marks', () => {
    const baseline = baselineFixture()
    const points = baseline.benchmarkSeries.doubleCostStrategy
    const index = points.findIndex(
      (point, pointIndex) =>
        points[pointIndex + 1] !== undefined && point.cashYieldMicros !== points[pointIndex + 1]?.cashYieldMicros,
    )
    if (index < 0) throw new Error('fixture requires adjacent differing cash-yield amounts')
    const first = points[index]
    const second = points[index + 1]
    const priorCumulative = BigInt(first.cumulativeCashYieldMicros) - BigInt(first.cashYieldMicros)
    const swappedFirst = {
      ...first,
      cashYieldMicros: second.cashYieldMicros,
      cumulativeCashYieldMicros: (priorCumulative + BigInt(second.cashYieldMicros)).toString(),
    }
    const swappedSecond = {
      ...second,
      cashYieldMicros: first.cashYieldMicros,
    }
    const tampered = {
      ...baseline,
      benchmarkSeries: {
        ...baseline.benchmarkSeries,
        doubleCostStrategy: points.map((point, pointIndex) =>
          pointIndex === index ? swappedFirst : pointIndex === index + 1 ? swappedSecond : point,
        ),
      },
    }

    expect(buildFixtureReport(reportFixture(0.01), tampered)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'double-cost-series.replay',
      },
    })
  })

  test('rejects an economic summary status that disagrees with its gates', () => {
    const baseline = baselineFixture()
    const inconsistent = {
      ...baseline,
      verdict: { ...baseline.verdict, status: 'FAIL_CLOSED' as const },
    }

    expect(buildFixtureReport(reportFixture(0.01), inconsistent)).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicVerdictInvalid',
        expectedStatus: 'PASS',
        observedStatus: 'FAIL_CLOSED',
        failedGateNames: [],
      }),
    )
  })

  test('rejects an incomplete economic gate set before deriving success', () => {
    const baseline = baselineFixture()
    const incomplete = {
      ...baseline,
      verdict: { status: 'PASS' as const, gates: baseline.verdict.gates.slice(0, -1) },
    }
    const expectedGateNames = baseline.verdict.gates.map((gate) => gate.name)

    expect(buildFixtureReport(reportFixture(0.01), incomplete)).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid',
        expectedGateNames,
        observedGateNames: expectedGateNames.slice(0, -1),
      }),
    )
  })

  test('rejects forged passing gates that disagree with decoded metrics', () => {
    const baseline = baselineFixture()
    const index = baseline.verdict.gates.findIndex((gate) => gate.name === 'positive_net_return')
    if (index < 0) throw new Error('positive return gate is missing')
    const expected = baseline.verdict.gates[index]
    const observed = { ...expected, passed: false, actual: 0 }
    const forged = {
      ...baseline,
      verdict: {
        ...baseline.verdict,
        gates: baseline.verdict.gates.map((gate, gateIndex) => (gateIndex === index ? observed : gate)),
      },
    }

    expect(buildFixtureReport(reportFixture(0.01), forged)).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CandidateDevelopmentCommandEconomicGateInvalid',
        index,
        expected,
        observed,
      },
    })
  })

  test('rejects passing summaries that disagree with the strategy simulation trace', () => {
    const baseline = baselineFixture()
    const tampered = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: baseline.simulation.dailyMarks.map((mark) => ({
          ...mark,
          equityMicros: fixtureInitialCapitalMicros,
          cashMicros: fixtureInitialCapitalMicros,
          peakEquityMicros: fixtureInitialCapitalMicros,
        })),
      },
    }

    expect(buildFixtureReport(reportFixture(0.01), tampered)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.replay.dailyMarks',
      },
    })
  })

  test('rejects strategy event totals that disagree with daily marks', () => {
    const baseline = baselineFixture()
    const event = baseline.events.find(
      (candidate): candidate is Extract<EvaluationResult['events'][number], { readonly kind: 'cash-yield' }> =>
        candidate.kind === 'cash-yield',
    )
    if (event === undefined) throw new Error('fixture must contain cash yield')
    const tampered = {
      ...baseline,
      events: baseline.events.map((candidate) =>
        candidate.id === event.id ? { ...event, amountMicros: '999999' } : candidate,
      ),
    }

    expect(buildFixtureReport(reportFixture(0.01), tampered)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.replay.monetaryEvents',
      },
    })
  })

  test('rejects selected strategy marks that disagree with marked equity', () => {
    const baseline = baselineFixture()
    const first = baseline.equitySeries[0]
    const tampered = {
      ...baseline,
      equitySeries: [{ ...first, evaluatorEquityMicros: '1999999' }, ...baseline.equitySeries.slice(1)],
    }

    expect(buildFixtureReport(reportFixture(0.01), tampered)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'proof-mismatch',
        field: 'accounting.markedEquityProof',
      },
    })
  })

  test('rejects a forged selected net return after full accounting reconciliation', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const first = baseline.simulation.dailyMarks[0]
    const tamperedMark = { ...first, netReturn: first.netReturn + 0.01 }
    const tamperedBaseline = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: [tamperedMark, ...baseline.simulation.dailyMarks.slice(1)],
      },
    }
    const evaluation = commandEvaluationFixture(report, tamperedBaseline, baseline)
    const accounting = {
      ...evaluation.accounting,
      baselineSimulation: {
        ...evaluation.accounting.baselineSimulation,
        dailyMarks: evaluation.accounting.baselineSimulation.dailyMarks.map((mark) =>
          mark.sessionDate === tamperedMark.sessionDate ? tamperedMark : mark,
        ),
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.replay.dailyMarks',
      },
    })
  })

  test('rebuilds marked equity instead of trusting a supplied proof', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const first = baseline.simulation.dailyMarks[0]
    const tamperedMark = { ...first, cashMicros: fixtureInitialCapitalMicros }
    const tamperedBaseline = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: [tamperedMark, ...baseline.simulation.dailyMarks.slice(1)],
      },
    }
    const evaluation = commandEvaluationFixture(report, tamperedBaseline, baseline)
    const accounting = {
      ...evaluation.accounting,
      baselineSimulation: {
        ...evaluation.accounting.baselineSimulation,
        dailyMarks: evaluation.accounting.baselineSimulation.dailyMarks.map((mark) =>
          mark.sessionDate === tamperedMark.sessionDate ? tamperedMark : mark,
        ),
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.replay.dailyMarks',
      },
    })
  })

  test('rebuilds stressed marked equity instead of trusting positive stressed summaries', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)
    const stressedSimulation = {
      ...report.doubledCost.stressed.simulation,
      cashChanges: [],
    }
    const tamperedReport = {
      ...report,
      doubledCost: {
        ...report.doubledCost,
        stressed: {
          ...report.doubledCost.stressed,
          simulation: stressedSimulation,
        },
      },
    }
    const tamperedEvaluation = {
      ...evaluation,
      stressed: tamperedReport.doubledCost.stressed,
      accounting: {
        ...evaluation.accounting,
        stressedEvents: evaluation.accounting.stressedEvents.filter((event) => event.kind === 'decision'),
        stressedSimulation: fullAccountingSimulationFixture(stressedSimulation),
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(tamperedReport, tamperedEvaluation, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'stressed.replay.monetaryEvents',
      },
    })
  })

  test('rejects a reconciled accounting suffix after the selected qualification window', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const lastMark = baseline.simulation.dailyMarks.at(-1)
    if (lastMark === undefined) throw new Error('baseline fixture must be nonempty')
    const suffixDate = new Date(Date.parse(`${lastMark.sessionDate}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10) as IsoDate
    const accountingSimulation = fullAccountingSimulationFixture(baseline.simulation)
    const suffixMark = {
      ...lastMark,
      sessionDate: suffixDate,
      netReturn: 0,
      turnoverMicros: '0',
      feeMicros: '0',
      spreadCostMicros: '0',
      slippageCostMicros: '0',
      cashYieldMicros: '0',
    }
    const fullSimulation = {
      ...accountingSimulation,
      dailyMarks: [...accountingSimulation.dailyMarks, suffixMark],
    }
    const proof = reconcileMarkedEquity({
      runId: baseline.runId,
      initialCapitalMicros: baseline.initialCapitalMicros,
      evaluatorTotalFeesMicros: baseline.strategy.totalFeesMicros,
      evaluatorEndingEquityMicros: baseline.strategy.endingEquityMicros,
      events: baseline.events,
      simulation: fullSimulation,
    })
    if (Result.isFailure(proof)) throw new Error(`suffix proof failed: ${JSON.stringify(proof.failure)}`)
    const baselineWithFullProof = {
      ...baseline,
      equitySeries: proof.success.equitySeries,
      markedEquityReconciliation: proof.success.reconciliation,
    }
    const evaluation = commandEvaluationFixture(report, baselineWithFullProof)
    const accounting = { ...evaluation.accounting, baselineSimulation: fullSimulation }

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'selected-trace-mismatch',
        field: 'baselineSimulation.terminalSession',
        expected: lastMark.sessionDate,
        observed: suffixDate,
      },
    })
  })

  test('rejects decision evidence after the governed qualification window', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const lastMark = baseline.simulation.dailyMarks.at(-1)
    if (lastMark === undefined) throw new Error('baseline fixture must be nonempty')
    const postWindowDate = new Date(Date.parse(`${lastMark.sessionDate}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10) as IsoDate
    const decisionPayload = {
      kind: 'decision' as const,
      signalDate: postWindowDate,
      executionDate: postWindowDate,
      targetWeights: { SPY: 0 },
    }
    const decision = {
      ...decisionPayload,
      id: canonicalHashV1({ runId: baseline.runId, ...decisionPayload }),
    }
    const signalDecision = {
      ...signalDecisionFixture,
      decisionId: decision.id,
      signalDate: postWindowDate,
      executionDate: postWindowDate,
      covarianceWindow: {
        ...signalDecisionFixture.covarianceWindow,
        firstSession: postWindowDate,
        lastSession: postWindowDate,
      },
    }
    const baselineWithDecision = {
      ...baseline,
      events: [...baseline.events, decision],
      signalDecisions: [...baseline.signalDecisions, signalDecision],
    }
    const evaluation = commandEvaluationFixture(report, baselineWithDecision)

    expect(buildCandidateDevelopmentCommandReport(report, evaluation, fixtureStrategyProtocol)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'selected-trace-mismatch',
        field: 'baselineSimulation.events.signalDate',
        expected: `<=${lastMark.sessionDate}`,
        observed: postWindowDate,
      },
    })
  })

  test('requires every selected baseline decision to have one matching accounting event', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const withoutDecision = {
      ...baseline,
      events: baseline.events.filter((event) => event.kind !== 'decision'),
    }
    const evaluation = commandEvaluationFixture(report, withoutDecision)

    expect(buildCandidateDevelopmentCommandReport(report, evaluation, fixtureStrategyProtocol)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.decisionCount',
        expected: 2,
        observed: 0,
      },
    })
  })

  test('requires stressed accounting decisions to preserve selected target weights', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)
    const accounting = {
      ...evaluation.accounting,
      stressedEvents: evaluation.accounting.stressedEvents.map((event) =>
        event.kind === 'decision' ? { ...event, targetWeights: { SPY: 0.5 } } : event,
      ),
    }

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'stressed.decision.targetWeights',
      },
    })
  })

  test('binds candidate economics to the hash-checked strategy protocol', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()

    const capitalProtocol = { ...fixtureStrategyProtocol, initialCapitalMicros: '1000001' }
    const capitalHash = canonicalHashV1(capitalProtocol)
    const capitalReport = {
      ...report,
      comparisonSemantics: { ...report.comparisonSemantics, strategyProtocolHash: capitalHash },
    }
    const capitalBaseline = { ...baseline, protocolHash: capitalHash }
    expect(
      buildCandidateDevelopmentCommandReport(
        capitalReport,
        commandEvaluationFixture(capitalReport, capitalBaseline),
        capitalProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'strategyProtocol.initialCapitalMicros',
        expected: '1000001',
        observed: fixtureInitialCapitalMicros,
      },
    })

    const universeProtocol = { ...fixtureStrategyProtocol, universe: [...fixtureStrategyProtocol.universe].reverse() }
    const universeHash = canonicalHashV1(universeProtocol)
    const universeReport = {
      ...report,
      comparisonSemantics: { ...report.comparisonSemantics, strategyProtocolHash: universeHash },
    }
    const universeBaseline = { ...baseline, protocolHash: universeHash }
    expect(
      buildCandidateDevelopmentCommandReport(
        universeReport,
        commandEvaluationFixture(universeReport, universeBaseline),
        universeProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'strategyProtocol.universe',
      },
    })

    const executionModel = {
      ...fixtureExecutionModel,
      priceImpact: { ...fixtureExecutionModel.priceImpact, halfSpreadBps: 1 },
    }
    const executionBaseline = {
      ...baseline,
      simulation: { ...baseline.simulation, executionModel },
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, executionBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'strategyProtocol.baselineExecutionModel',
      },
    })
  })

  test('derives baseline and stressed cash-yield intervals from adjacent accounting sessions', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const baselineYield = baseline.events.find(
      (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'cash-yield' }> =>
        event.kind === 'cash-yield',
    )
    if (baselineYield === undefined) throw new Error('baseline fixture must contain cash yield')
    const baselineWithWrongInterval = {
      ...baseline,
      events: baseline.events.map((event) =>
        event.id === baselineYield.id ? { ...baselineYield, elapsedDays: 2 } : event,
      ),
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, baselineWithWrongInterval),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.cashYield.elapsedDays',
        expected: 1,
        observed: 2,
      },
    })

    const evaluation = commandEvaluationFixture(report, baseline)
    const stressedYield = evaluation.accounting.stressedEvents.find(
      (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'cash-yield' }> =>
        event.kind === 'cash-yield',
    )
    if (stressedYield === undefined) throw new Error('stressed fixture must contain cash yield')
    const accounting = {
      ...evaluation.accounting,
      stressedEvents: evaluation.accounting.stressedEvents.map((event) =>
        event.id === stressedYield.id ? { ...stressedYield, elapsedDays: 2 } : event,
      ),
    }
    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'stressed.cashYield.elapsedDays',
        expected: 1,
        observed: 2,
      },
    })
  })
})
