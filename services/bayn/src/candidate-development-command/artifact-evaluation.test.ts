import { describe, expect, test } from 'bun:test'
import {
  bindCandidateDevelopmentVerifiedSource,
  buildCandidateDevelopmentCommandReportPure,
  buildCandidateDevelopmentPlanEvaluation,
  candidateDevelopmentComparisonSemantics,
  canonicalHashV1,
  DataFeed,
  DataSource,
  defaultProtocolDocument,
  evaluateCandidateDevelopmentArtifact,
  executeCandidateDevelopmentArtifactRuntime,
  expectedCandidateDevelopmentRebalanceSchedule,
  frozenCandidateDevelopmentSessions,
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  PriceAdjustment,
  PublicationSchema,
  sha256,
  type CandidateDevelopmentCommandEvaluation,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentReport,
  type CandidateDevelopmentSourceManifest,
  type CandidateDevelopmentStrategyPlan,
  type CandidateDevelopmentStrategyProtocol,
  type CandidateDevelopmentVerifiedSourceFiles,
  type IsoDate,
  validateCandidateDevelopmentExecutableProgram,
} from './test-api'
import { Effect, Result } from './test-runtime'
import {
  baselineFixture,
  commandEvaluationFixture,
  frozenSourceInput,
  frozenSourceStrategyProtocol,
  frozenSourceStructuralBindings,
  frozenSourceVerifiedSourceFiles,
  reportFixture,
  successOf,
  syntheticFrozenSourceRuntime,
} from './test-support'

describe('candidate development artifact evaluation', () => {
  test('evaluates the immutable artifact without host code-loading capabilities', async () => {
    const input = frozenSourceInput
    const verifiedSource = successOf(bindCandidateDevelopmentVerifiedSource(frozenSourceVerifiedSourceFiles, input))
    const report = reportFixture(0.01)
    const baseEvaluation = commandEvaluationFixture(report, baselineFixture())
    const evaluation = {
      ...baseEvaluation,
      baseline: {
        ...baseEvaluation.baseline,
        runId: verifiedSource.baselineRunId,
        codeRevision: verifiedSource.sourceRevision,
      },
      accounting: {
        ...baseEvaluation.accounting,
        runId: verifiedSource.baselineRunId,
        stressedRunId: verifiedSource.stressedRunId,
      },
    }
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(frozenSourceStrategyProtocol)},
        structuralBindings: ${JSON.stringify(frozenSourceStructuralBindings)},
        buildEvaluation: (verifiedSource) => {
          const unavailable = [
            typeof globalThis['process'],
            typeof globalThis['Bun'],
            typeof globalThis['fetch'],
            typeof globalThis['require'],
            typeof globalThis['module'],
            typeof globalThis['Promise'],
            typeof globalThis['ShadowRealm'],
            typeof globalThis['Atomics'],
            typeof globalThis['SharedArrayBuffer'],
            typeof globalThis['Date'],
            typeof globalThis['Intl'],
            typeof globalThis['Loader'],
            typeof globalThis['Temporal'],
            typeof globalThis['performance'],
            typeof globalThis['crypto'],
            typeof globalThis['navigator'],
            typeof globalThis['WebAssembly'],
            typeof globalThis['Worker'],
            typeof globalThis['setTimeout'],
            typeof Math['random'],
            typeof String.prototype['localeCompare'],
            typeof Number.prototype['toLocaleString'],
          ].every((value) => value === 'undefined')
          let functionBlocked = false
          let constructorBlocked = false
          let evalBlocked = false
          const functionSourceUnavailable =
            candidateDevelopmentArtifact.buildEvaluation.toString() ===
              'function () { [source unavailable] }' &&
            String(candidateDevelopmentArtifact.buildEvaluation) ===
              'function () { [source unavailable] }'
          try { globalThis['Function']('return 1')() } catch { functionBlocked = true }
          try { ({}).constructor.constructor('return 1')() } catch { constructorBlocked = true }
          try { globalThis['eval']('1') } catch { evalBlocked = true }
          if (
            !unavailable ||
            globalThis.constructor !== null ||
            !functionBlocked ||
            !constructorBlocked ||
            !evalBlocked ||
            !functionSourceUnavailable ||
            verifiedSource.sourceRevision !== ${JSON.stringify(verifiedSource.sourceRevision)} ||
            verifiedSource.baselineRunId !== ${JSON.stringify(verifiedSource.baselineRunId)} ||
            verifiedSource.stressedRunId !== ${JSON.stringify(verifiedSource.stressedRunId)}
          ) {
            throw new Error('candidate artifact sandbox is not closed')
          }
          return ${JSON.stringify(evaluation)}
        },
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    const loaded = await Effect.runPromise(
      evaluateCandidateDevelopmentArtifact(moduleUrl, frozenSourceVerifiedSourceFiles),
    )
    const program = successOf(
      validateCandidateDevelopmentExecutableProgram(
        (loaded as { readonly candidateDevelopmentProgram?: unknown }).candidateDevelopmentProgram,
      ),
    )
    expect(program.input).toEqual(frozenSourceInput)
    const runtime = syntheticFrozenSourceRuntime(verifiedSource)
    const decoded = await Effect.runPromise(
      executeCandidateDevelopmentArtifactRuntime(
        moduleUrl,
        runtime.verifiedFiles,
        runtime.strategyProtocol,
        runtime.runtimeInput,
      ),
    )

    expect(decoded.baseline.codeRevision).toBe(verifiedSource.sourceRevision)
    expect(decoded.baseline.runId).toBe(verifiedSource.baselineRunId)
    expect(decoded.accounting.stressedRunId).toBe(verifiedSource.stressedRunId)
  })

  test('constructs simulator, cost, benchmark, and reconciliation evidence from a bounded strategy plan', async () => {
    const officialSessions = frozenCandidateDevelopmentSessions()
    const universe = [...defaultProtocolDocument.universe]
    const firstSession = officialSessions[0]
    const lastSession = officialSessions.at(-1)
    if (firstSession === undefined || lastSession === undefined) {
      throw new Error('candidate plan regression requires the frozen calendar')
    }
    const geometryPreflight = successOf(
      preflightCandidateDevelopment({
        candidateOrdinal: 21,
        priorTrialCount: 20,
        expectedStrategyProtocolHash: '0'.repeat(64),
        officialSessions,
        signalSessionDates: officialMonthEndSignalDates(officialSessions),
        featureLookbackSessions: 252,
      }),
    )
    if (geometryPreflight.status !== 'PASS') {
      throw new Error('candidate plan regression requires passing geometry')
    }
    const symbols = universe.map((symbol) => ({
      symbol,
      rows: officialSessions.length,
      firstSession,
      lastSession,
    }))
    const manifestMaterial = {
      schemaVersion: 'bayn.input-manifest.v3' as const,
      database: 'signal' as const,
      bounds: {
        schemaVersion: 'bayn.evaluation-bounds.v1' as const,
        dataStart: firstSession,
        dataEnd: lastSession,
        lookbackStart: firstSession,
        evaluationStart: geometryPreflight.selectedObservationStart,
        evaluationEnd: geometryPreflight.selectedObservationEnd,
      },
      rowCount: officialSessions.length * universe.length,
      sessionCount: officialSessions.length,
      firstSession,
      lastSession,
      symbols,
      tables: {
        bars: 'adjusted_daily_bars_v2' as const,
        sessions: 'exchange_sessions_v1' as const,
        manifests: 'snapshot_manifests_v2' as const,
      },
      finalizedSnapshot: {
        schemaVersion: 'bayn.finalized-snapshot.v3' as const,
        publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
        universeId: 'cross-asset-taa-v1' as const,
        universeSymbolHash: sha256(universe.join(',')),
        snapshotId: 'a'.repeat(64),
        publicationId: 'b'.repeat(64),
        source: DataSource.Alpaca,
        sourceFeed: DataFeed.Sip,
        adjustment: PriceAdjustment.All,
        calendarVersion: 'alpaca-us-equity-calendar-v1',
        publisherSourceRevision: 'c'.repeat(40),
        publisherImage: {
          repository: 'registry.example.test/bayn',
          digest: `sha256:${'d'.repeat(64)}` as const,
        },
        finalizedAt: '2026-07-01T00:00:00.000Z',
        requestedStart: firstSession,
        firstSession,
        lastSession,
        asOfSession: lastSession,
        symbols: universe,
        rowCount: officialSessions.length * universe.length,
        sessionCount: officialSessions.length,
        contentHash: 'e'.repeat(64),
        sessionsContentHash: 'f'.repeat(64),
      },
    }
    const inputManifest = { ...manifestMaterial, hash: canonicalHashV1(manifestMaterial) }
    const bars = officialSessions.flatMap((sessionDate, sessionIndex) =>
      universe.map((symbol, symbolIndex) => {
        const close = 100 + sessionIndex * (symbol === 'SPY' ? 0.015 : 0.003 + symbolIndex * 0.001)
        return {
          symbol,
          sessionDate,
          open: close,
          high: close + 1,
          low: close - 1,
          close,
          volume: 1_000_000,
          source: DataSource.Alpaca,
          sourceFeed: DataFeed.Sip,
          adjustment: PriceAdjustment.All,
          publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
        }
      }),
    )
    const marketDataMaterial = {
      schemaVersion: 'bayn.candidate-development-market-data-witness.v1' as const,
      snapshotId: inputManifest.finalizedSnapshot.snapshotId,
      inputManifestHash: inputManifest.hash,
      bars,
    }
    const marketData = { ...marketDataMaterial, contentHash: canonicalHashV1(marketDataMaterial) }
    const strategyProtocol: CandidateDevelopmentStrategyProtocol = {
      schemaVersion: 'bayn.candidate-development-strategy-protocol.v2',
      universe,
      directVolatilityTarget: defaultProtocolDocument.directVolatilityTarget,
      initialCapitalMicros: '1000000000000',
      executionModel: defaultProtocolDocument.executionModel,
      thresholds: defaultProtocolDocument.thresholds,
      marketData: {
        schemaVersion: 'bayn.candidate-development-market-data-contract.v1',
        snapshotId: marketData.snapshotId,
        contentHash: marketData.contentHash,
      },
      benchmarks: {
        schemaVersion: 'bayn.candidate-development-benchmark-policy.v1',
        symbol: 'SPY',
        directVolatilityWindow: 63,
        terminalPolicy: 'last-all-cash-strategy-decision',
      },
      strategyIdentity: {
        schemaVersion: 'bayn.candidate-development-strategy-identity.v2',
        family: 'inverse-volatility-risk-diversification',
        identifier: 'candidate-plan-host-regression',
        researchSources: ['source-a', 'source-b', 'source-c'],
        parameters: {
          id: 'candidate-plan-host-regression-v1',
          lookbackSessions: 252,
          annualizationSessions: 252,
          riskAssets: ['SPY', 'EFA'],
          covarianceEstimator: 'sample',
          targetAnnualizedVolatility: 0.1,
          maximumGrossExposure: 0.2,
        },
        input: 'content-verified adjusted closes',
        weighting: 'inverse volatility',
        riskScaling: 'fixed regression scale',
        allocation: 'single bounded risk asset',
        schedule: 'governed month end',
        terminal: 'all cash',
        missingData: 'fail closed',
        doubledCost: 'trusted host replay',
      },
    }
    const preflightInput: CandidateDevelopmentPreflightInput = {
      candidateOrdinal: 21,
      priorTrialCount: 20,
      expectedStrategyProtocolHash: canonicalHashV1(strategyProtocol),
      officialSessions,
      signalSessionDates: officialMonthEndSignalDates(officialSessions),
      featureLookbackSessions: 252,
    }
    const preflight = successOf(preflightCandidateDevelopment(preflightInput))
    if (preflight.status !== 'PASS') throw new Error('candidate plan regression requires passing geometry')
    const selectedStartIndex = officialSessions.indexOf(preflight.selectedObservationStart)
    const accountingStart = officialSessions[selectedStartIndex - 1]
    if (accountingStart === undefined) throw new Error('candidate plan regression requires an accounting predecessor')
    const planSchedule = expectedCandidateDevelopmentRebalanceSchedule(
      officialSessions,
      preflightInput.signalSessionDates,
      accountingStart,
      preflight.selectedObservationEnd,
    )
    expect(planSchedule.slice(1)).toEqual([...preflight.expectedRebalanceSchedule])
    const inverseVolatilityIdentity = strategyProtocol.strategyIdentity
    if (inverseVolatilityIdentity?.schemaVersion !== 'bayn.candidate-development-strategy-identity.v2') {
      throw new Error('candidate plan regression requires inverse-volatility identity')
    }
    const inverseVolatilityParameters = inverseVolatilityIdentity.parameters
    const quantize = (value: number): number => Math.round(value * 1_000_000_000_000) / 1_000_000_000_000
    const sampleVariance = (values: readonly number[]): number => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    }
    const sampleCovariance = (first: readonly number[], second: readonly number[]): number => {
      const firstMean = first.reduce((sum, value) => sum + value, 0) / first.length
      const secondMean = second.reduce((sum, value) => sum + value, 0) / second.length
      return (
        first.reduce(
          (sum, value, valueIndex) => sum + (value - firstMean) * ((second[valueIndex] as number) - secondMean),
          0,
        ) /
        (first.length - 1)
      )
    }
    const closeBySessionAndSymbol = new Map<string, number>(
      bars.map((bar) => [`${bar.sessionDate}:${bar.symbol}`, bar.close] as const),
    )
    const closeAt = (sessionIndex: number, symbol: string): number => {
      const session = officialSessions[sessionIndex]
      const close = session === undefined ? undefined : closeBySessionAndSymbol.get(`${session}:${symbol}`)
      if (close === undefined) throw new Error(`candidate plan fixture is missing ${sessionIndex}:${symbol}`)
      return close
    }
    const decisions = planSchedule.map(({ signalDate, executionDate }, index) => {
      const terminal = index === planSchedule.length - 1
      const signalIndex = officialSessions.indexOf(signalDate)
      const firstPriceSessionIndex = signalIndex - inverseVolatilityParameters.lookbackSessions
      const dailyReturns = Object.fromEntries(
        universe.map((symbol) => [
          symbol,
          Array.from({ length: inverseVolatilityParameters.lookbackSessions }, (_, returnIndex) => {
            const currentIndex = firstPriceSessionIndex + returnIndex + 1
            return closeAt(currentIndex, symbol) / closeAt(currentIndex - 1, symbol) - 1
          }),
        ]),
      ) as Record<string, readonly number[]>
      const totalReturns = Object.fromEntries(
        universe.map((symbol) => [
          symbol,
          quantize(closeAt(signalIndex, symbol) / closeAt(firstPriceSessionIndex, symbol) - 1),
        ]),
      ) as Record<string, number>
      const annualizedVolatilities = Object.fromEntries(
        universe.map((symbol) => [
          symbol,
          quantize(
            Math.sqrt(
              sampleVariance(dailyReturns[symbol] as readonly number[]) *
                inverseVolatilityParameters.annualizationSessions,
            ),
          ),
        ]),
      ) as Record<string, number>
      const [firstRiskAsset, secondRiskAsset] = inverseVolatilityParameters.riskAssets
      const firstInverseVolatility = 1 / (annualizedVolatilities[firstRiskAsset] as number)
      const secondInverseVolatility = 1 / (annualizedVolatilities[secondRiskAsset] as number)
      const inverseVolatilityDenominator = firstInverseVolatility + secondInverseVolatility
      const normalizedWeights = {
        [firstRiskAsset]: firstInverseVolatility / inverseVolatilityDenominator,
        [secondRiskAsset]: secondInverseVolatility / inverseVolatilityDenominator,
      }
      const annualizedCovariance =
        sampleCovariance(
          dailyReturns[firstRiskAsset] as readonly number[],
          dailyReturns[secondRiskAsset] as readonly number[],
        ) * inverseVolatilityParameters.annualizationSessions
      const unscaledPortfolioVariance =
        (normalizedWeights[firstRiskAsset] as number) ** 2 * (annualizedVolatilities[firstRiskAsset] as number) ** 2 +
        (normalizedWeights[secondRiskAsset] as number) ** 2 * (annualizedVolatilities[secondRiskAsset] as number) ** 2 +
        2 *
          (normalizedWeights[firstRiskAsset] as number) *
          (normalizedWeights[secondRiskAsset] as number) *
          annualizedCovariance
      const riskScale = quantize(
        Math.min(
          inverseVolatilityParameters.maximumGrossExposure,
          inverseVolatilityParameters.targetAnnualizedVolatility / Math.sqrt(unscaledPortfolioVariance),
        ),
      )
      const targetWeights = Object.fromEntries(
        universe.map((symbol) => [
          symbol,
          terminal
            ? 0
            : symbol === firstRiskAsset || symbol === secondRiskAsset
              ? quantize((normalizedWeights[symbol] as number) * riskScale)
              : 0,
        ]),
      ) as Record<string, number>
      const exposureScale = quantize(Object.values(targetWeights).reduce((sum, weight) => sum + weight, 0))
      const portfolioReturns = Array.from({ length: inverseVolatilityParameters.lookbackSessions }, (_, returnIndex) =>
        universe.reduce(
          (sum, symbol) => sum + (dailyReturns[symbol]?.[returnIndex] as number) * (targetWeights[symbol] as number),
          0,
        ),
      )
      const covarianceWindowSessions = officialSessions.slice(
        signalIndex - inverseVolatilityParameters.lookbackSessions + 1,
        signalIndex + 1,
      )
      return {
        schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1' as const,
        signalDate,
        executionDate,
        covarianceWindow: {
          returnCount: inverseVolatilityParameters.lookbackSessions,
          firstSession: covarianceWindowSessions[0] as IsoDate,
          lastSession: signalDate,
          sessionsHash: 'a'.repeat(64),
        },
        estimatedAnnualizedPortfolioVolatility: quantize(
          Math.sqrt(sampleVariance(portfolioReturns) * inverseVolatilityParameters.annualizationSessions),
        ),
        exposureScale,
        targetWeights,
        signals: universe.map((symbol) => ({
          symbol,
          horizons: [
            {
              horizonSessions: inverseVolatilityParameters.lookbackSessions,
              return: totalReturns[symbol] as number,
              normalizedTrend: totalReturns[symbol] as number,
            },
          ],
          dailyVolatility:
            (annualizedVolatilities[symbol] as number) / Math.sqrt(inverseVolatilityParameters.annualizationSessions),
          annualizedVolatility: annualizedVolatilities[symbol] as number,
          compositeScore:
            symbol === firstRiskAsset || symbol === secondRiskAsset
              ? 1 / (annualizedVolatilities[symbol] as number)
              : 0,
          positiveScore:
            symbol === firstRiskAsset || symbol === secondRiskAsset
              ? 1 / (annualizedVolatilities[symbol] as number)
              : 0,
          eligible: symbol === firstRiskAsset || symbol === secondRiskAsset,
          uncappedWeight: targetWeights[symbol] as number,
          cappedWeight: targetWeights[symbol] as number,
          targetWeight: targetWeights[symbol] as number,
        })),
      }
    })
    const plan: CandidateDevelopmentStrategyPlan = {
      schemaVersion: 'bayn.candidate-development-strategy-plan.v1',
      decisions,
    }
    const sourceManifest: CandidateDevelopmentSourceManifest = {
      schemaVersion: 'bayn.candidate-development-source-manifest.v1',
      candidateOrdinal: 21,
      priorTrialCount: 20,
      strategyProtocolHash: preflightInput.expectedStrategyProtocolHash,
      modulePath: 'services/bayn/src/strategy/fixture/candidate-21.ts',
      moduleFormat: 'self-contained-esm-v1',
      marketData: {
        schemaVersion: 'bayn.candidate-development-market-data-source.v1',
        snapshotId: marketData.snapshotId,
        finalizedSnapshotContentHash: inputManifest.finalizedSnapshot.contentHash,
        inputManifestHash: inputManifest.hash,
        boundedContentHash: marketData.contentHash,
      },
    }
    const runtimeInput = {
      schemaVersion: 'bayn.candidate-development-verified-source.v1' as const,
      sourceRevision: '1'.repeat(40),
      modulePath: sourceManifest.modulePath,
      moduleBlobOid: '2'.repeat(40),
      moduleSha256: '3'.repeat(64),
      sourceManifestPath: 'services/bayn/candidates/fixture-candidate-21-source-manifest.json',
      sourceManifestBlobOid: '4'.repeat(40),
      sourceManifestSha256: '5'.repeat(64),
      sourceManifest,
      baselineRunId: '6'.repeat(64),
      stressedRunId: '7'.repeat(64),
      runtimeDataSchemaVersion: 'bayn.candidate-development-artifact-runtime-input.v1' as const,
      preflightInput,
      marketData,
    }
    const builtResult = buildCandidateDevelopmentPlanEvaluation(plan, inputManifest, runtimeInput, strategyProtocol)
    if (Result.isFailure(builtResult)) {
      throw new Error(`candidate plan evaluation failed: ${JSON.stringify(builtResult.failure)}`)
    }
    const built = builtResult.success
    expect(
      built.baseline.signalDecisions.map(({ signalDate, executionDate }) => ({ signalDate, executionDate })),
    ).toEqual([...preflight.expectedRebalanceSchedule])
    expect(
      built.accounting.signalDecisions.map(({ signalDate, executionDate }) => ({ signalDate, executionDate })),
    ).toEqual([...planSchedule])
    expect(built.accounting.signalDecisions).toHaveLength(built.baseline.signalDecisions.length + 1)
    expect(built.baseline.simulation.dailyMarks.map(({ sessionDate }) => sessionDate)).toEqual([
      ...preflight.selectedObservationSessions,
    ])
    expect(built.accounting.baselineSimulation.dailyMarks[0]?.sessionDate).toBe(accountingStart)
    expect(
      built.accounting.baselineSimulation.dailyMarks[0]?.positions.some(({ quantityMicros }) => quantityMicros !== '0'),
    ).toBe(true)
    const baselinePredecessor = built.accounting.baselineSimulation.dailyMarks[0]
    const baselineTerminal = built.baseline.simulation.dailyMarks.at(-1)
    if (baselinePredecessor === undefined || baselineTerminal === undefined) {
      throw new Error('candidate plan regression requires baseline accounting bounds')
    }
    expect(BigInt(baselinePredecessor.cumulativeTurnoverMicros)).toBeGreaterThan(0n)
    expect(BigInt(baselinePredecessor.cumulativeFeesMicros)).toBeGreaterThan(0n)
    expect(built.baseline.strategy.totalReturn).toBe(
      Number(BigInt(baselineTerminal.equityMicros)) / Number(BigInt(baselinePredecessor.equityMicros)) - 1,
    )
    expect(built.baseline.strategy.annualTurnover).toBeCloseTo(
      Number(BigInt(baselineTerminal.cumulativeTurnoverMicros) - BigInt(baselinePredecessor.cumulativeTurnoverMicros)) /
        Number(BigInt(baselinePredecessor.equityMicros)) /
        (built.baseline.simulation.dailyMarks.length / 252),
      15,
    )
    expect(built.baseline.strategy.totalFeesMicros).toBe(
      (BigInt(baselineTerminal.cumulativeFeesMicros) - BigInt(baselinePredecessor.cumulativeFeesMicros)).toString(),
    )
    expect(built.baseline.strategy.totalSpreadCostMicros).toBe(
      (
        BigInt(baselineTerminal.cumulativeSpreadCostMicros) - BigInt(baselinePredecessor.cumulativeSpreadCostMicros)
      ).toString(),
    )
    expect(built.baseline.strategy.totalSlippageCostMicros).toBe(
      (
        BigInt(baselineTerminal.cumulativeSlippageCostMicros) - BigInt(baselinePredecessor.cumulativeSlippageCostMicros)
      ).toString(),
    )
    expect(built.baseline.strategy.totalCashYieldMicros).toBe(
      (
        BigInt(baselineTerminal.cumulativeCashYieldMicros) - BigInt(baselinePredecessor.cumulativeCashYieldMicros)
      ).toString(),
    )
    expect(built.accounting.evaluatorTotalFeesMicros).toBe(baselineTerminal.cumulativeFeesMicros)
    expect(built.accounting.evaluatorTotalFeesMicros).not.toBe(built.baseline.strategy.totalFeesMicros)
    expect(built.accounting.stressedSimulation.dailyMarks[0]?.equityMicros).not.toBe(
      strategyProtocol.initialCapitalMicros,
    )
    expect(built.accounting.baselineSimulation.dailyMarks.length).toBe(built.baseline.simulation.dailyMarks.length + 1)
    expect(built.accounting.stressedSimulation.costMultiplierMicros).toBe('2000000')
    expect(built.accounting.runId).not.toBe(built.accounting.stressedRunId)
    expect(built.accounting.signalDecisions[0]?.decisionId).not.toBe(built.stressed.signalDecisions[0]?.decisionId)
    const firstSelectedStressedDecision = built.stressed.signalDecisions[0]
    expect(
      built.accounting.stressedEvents.find(
        (event) => event.kind === 'decision' && event.signalDate === firstSelectedStressedDecision?.signalDate,
      )?.id,
    ).toBe(firstSelectedStressedDecision?.decisionId)
    expect(built.accounting.markedEquityReconciliation.exact).toBe(true)
    expect(built.accounting.stressedMarkedEquityReconciliation.exact).toBe(true)
    const developmentReport: CandidateDevelopmentReport = {
      schemaVersion: candidateDevelopmentComparisonSemantics.evidence.reportSchemaVersion,
      protocolIdentity: preflight.protocolIdentity,
      comparisonSemantics: built.comparisonSemantics,
      doubledCostContract: preflight.doubledCostContract,
      doubledCost: {
        baseline: {
          signalDecisions: built.baseline.signalDecisions,
          simulation: built.baseline.simulation,
        },
        stressed: built.stressed,
      },
    }
    const commandReport = buildCandidateDevelopmentCommandReportPure(
      developmentReport,
      built,
      strategyProtocol,
      preflightInput.officialSessions,
      runtimeInput,
    )
    if (Result.isFailure(commandReport)) {
      throw new Error(`candidate plan report failed: ${JSON.stringify(commandReport.failure)}`)
    }
    expect(commandReport.success.accounting.signalDecisions).toHaveLength(planSchedule.length)
    const firstDecision = plan.decisions[0]
    if (firstDecision === undefined) throw new Error('candidate plan regression requires one decision')
    expect(firstDecision.exposureScale).toBe(
      quantize(Object.values(firstDecision.targetWeights).reduce((sum, weight) => sum + weight, 0)),
    )
    expect(firstDecision.signals.every((signal) => signal.cappedWeight === signal.targetWeight)).toBe(true)
    expect(firstDecision.signals.every((signal) => signal.uncappedWeight === signal.targetWeight)).toBe(true)
    const firstDecisionGrossExposure = Object.values(firstDecision.targetWeights).reduce(
      (sum, weight) => sum + weight,
      0,
    )
    const forgedRiskAllocationSignals = firstDecision.signals.map((signal) => {
      const targetWeight = signal.symbol === 'SPY' ? firstDecisionGrossExposure : 0
      return {
        ...signal,
        uncappedWeight: targetWeight,
        cappedWeight: targetWeight,
        targetWeight,
      }
    })
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...plan,
          decisions: [
            {
              ...firstDecision,
              targetWeights: Object.fromEntries(
                universe.map((symbol) => [symbol, symbol === 'SPY' ? firstDecisionGrossExposure : 0]),
              ),
              signals: forgedRiskAllocationSignals,
            },
            ...plan.decisions.slice(1),
          ],
        },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].inverseVolatility.allocation' },
      },
    })
    const forgedRiskGeometrySignals = firstDecision.signals.map((signal) =>
      signal.symbol === 'SPY'
        ? {
            ...signal,
            dailyVolatility: 0,
            annualizedVolatility: 0,
            compositeScore: 0,
            positiveScore: 0,
          }
        : signal,
    )
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...plan,
          decisions: [{ ...firstDecision, signals: forgedRiskGeometrySignals }, ...plan.decisions.slice(1)],
        },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].signals[3].inverseVolatility' },
      },
    })
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...plan,
          decisions: [
            {
              ...firstDecision,
              estimatedAnnualizedPortfolioVolatility: firstDecision.estimatedAnnualizedPortfolioVolatility + 0.01,
            },
            ...plan.decisions.slice(1),
          ],
        },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].inverseVolatility.riskScale' },
      },
    })
    const firstSignalIndex = officialSessions.indexOf(firstDecision.signalDate)
    expect(built.accounting.signalDecisions[0]?.covarianceWindow).toEqual({
      returnCount: 252,
      firstSession: officialSessions[firstSignalIndex - 251],
      lastSession: firstDecision.signalDate,
      sessionsHash: canonicalHashV1({
        schemaVersion: 'bayn.candidate-development-plan-window.v1',
        sessions: officialSessions.slice(firstSignalIndex - 252, firstSignalIndex + 1),
      }),
    })
    const shiftedCaps = firstDecision.signals.map((signal) => {
      if (signal.symbol === 'SPY') return { ...signal, cappedWeight: signal.cappedWeight - 0.01 }
      if (signal.symbol === 'EFA') return { ...signal, cappedWeight: signal.cappedWeight + 0.01 }
      return signal
    })
    const shiftedCapsIndex = firstDecision.signals.findIndex((signal) => signal.symbol === 'EFA')
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        { ...plan, decisions: [{ ...firstDecision, signals: shiftedCaps }, ...plan.decisions.slice(1)] },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: `artifact.plan.decisions[0].signals[${shiftedCapsIndex}]` },
      },
    })
    const shiftedUncappedSignals = firstDecision.signals.map((signal) => {
      if (signal.symbol === 'SPY') return { ...signal, uncappedWeight: signal.uncappedWeight - 0.01 }
      if (signal.symbol === 'EFA') return { ...signal, uncappedWeight: signal.uncappedWeight + 0.01 }
      return signal
    })
    const shiftedUncappedIndex = firstDecision.signals.findIndex((signal) => signal.symbol === 'EFA')
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        { ...plan, decisions: [{ ...firstDecision, signals: shiftedUncappedSignals }, ...plan.decisions.slice(1)] },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: `artifact.plan.decisions[0].signals[${shiftedUncappedIndex}]` },
      },
    })
    const ungovernedSignals = firstDecision.signals.map((signal) => {
      if (signal.symbol === 'DBC') {
        return { ...signal, eligible: true, uncappedWeight: 0.175, cappedWeight: 0.175, targetWeight: 0.175 }
      }
      if (signal.symbol === 'SPY') {
        return { ...signal, eligible: false, uncappedWeight: 0, cappedWeight: 0, targetWeight: 0 }
      }
      return signal
    })
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...plan,
          decisions: [
            {
              ...firstDecision,
              targetWeights: { ...firstDecision.targetWeights, DBC: 0.175, SPY: 0 },
              signals: ungovernedSignals,
            },
            ...plan.decisions.slice(1),
          ],
        },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].inverseVolatility.allocation' },
      },
    })
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...plan,
          decisions: [
            {
              ...firstDecision,
              covarianceWindow: { ...firstDecision.covarianceWindow, returnCount: 251 },
            },
            ...plan.decisions.slice(1),
          ],
        },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].covarianceWindow' },
      },
    })
    const wrongHorizonSignals = firstDecision.signals.map((signal) => ({
      ...signal,
      horizons: [{ ...signal.horizons[0], horizonSessions: 63 }],
    }))
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        { ...plan, decisions: [{ ...firstDecision, signals: wrongHorizonSignals }, ...plan.decisions.slice(1)] },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].signals[0].horizons' },
      },
    })
    const overexposedSignals = firstDecision.signals.map((signal) =>
      signal.symbol === 'SPY' ? { ...signal, cappedWeight: 0.45, targetWeight: 0.225 } : signal,
    )
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...plan,
          decisions: [
            {
              ...firstDecision,
              targetWeights: { ...firstDecision.targetWeights, SPY: 0.225 },
              signals: overexposedSignals,
            },
            ...plan.decisions.slice(1),
          ],
        },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].inverseVolatility.allocation' },
      },
    })
    const momentumStrategyProtocol: CandidateDevelopmentStrategyProtocol = {
      ...strategyProtocol,
      strategyIdentity: {
        schemaVersion: 'bayn.candidate-development-strategy-identity.v1',
        family: 'dual-momentum',
        identifier: 'candidate-plan-momentum-host-regression',
        researchSources: ['source-a', 'source-b', 'source-c'],
        parameters: {
          id: 'candidate-plan-momentum-host-regression-v1',
          lookbackSessions: 252,
          volatilityWindowSessions: 252,
          annualizationSessions: 252,
          riskAssets: ['SPY', 'EFA'],
          defensiveAsset: 'IEF',
          absoluteMomentumThreshold: 0,
          selectedAssetWeight: 0.2,
          relativeMomentumTieBreak: 'SPY',
        },
        input: 'content-verified adjusted closes',
        relativeMomentum: 'select the stronger risk asset with the immutable tie break',
        absoluteMomentum: 'require the winning risk asset to clear the immutable threshold',
        defensive: 'select the defensive asset only when risk fails and defense clears the threshold',
        allocation: 'one selected governed asset or cash',
        schedule: 'governed month end',
        terminal: 'all cash',
        missingData: 'fail closed',
        doubledCost: 'trusted host replay',
      },
    }
    const momentumStrategyProtocolHash = canonicalHashV1(momentumStrategyProtocol)
    const momentumIdentity = momentumStrategyProtocol.strategyIdentity
    if (momentumIdentity?.schemaVersion !== 'bayn.candidate-development-strategy-identity.v1') {
      throw new Error('candidate momentum plan requires the governed momentum identity')
    }
    const momentumParameters = momentumIdentity.parameters
    const momentumRuntimeInput = {
      ...runtimeInput,
      preflightInput: {
        ...runtimeInput.preflightInput,
        expectedStrategyProtocolHash: momentumStrategyProtocolHash,
      },
      sourceManifest: {
        ...runtimeInput.sourceManifest,
        strategyProtocolHash: momentumStrategyProtocolHash,
      },
    }
    const momentumDecisions = plan.decisions.map((decision, index) => {
      const signalIndex = officialSessions.indexOf(decision.signalDate)
      const firstFeatureSession = officialSessions[signalIndex - momentumParameters.lookbackSessions] as IsoDate
      const totalReturns = Object.fromEntries(
        universe.map((symbol) => {
          const firstClose = closeBySessionAndSymbol.get(`${firstFeatureSession}:${symbol}`) as number
          const signalClose = closeBySessionAndSymbol.get(`${decision.signalDate}:${symbol}`) as number
          return [symbol, Math.round((signalClose / firstClose - 1) * 1_000_000_000_000) / 1_000_000_000_000]
        }),
      )
      const relativeWinner = (totalReturns.SPY as number) >= (totalReturns.EFA as number) ? 'SPY' : 'EFA'
      const selectedSymbol =
        (totalReturns[relativeWinner] as number) > 0 ? relativeWinner : (totalReturns.IEF as number) > 0 ? 'IEF' : null
      const terminal = index === plan.decisions.length - 1
      const targetWeights = Object.fromEntries(
        universe.map((symbol) => [
          symbol,
          !terminal && selectedSymbol === symbol ? momentumParameters.selectedAssetWeight : 0,
        ]),
      ) as Record<string, number>
      const volatilityStartIndex = signalIndex - momentumParameters.volatilityWindowSessions + 1
      const portfolioReturns = Array.from({ length: momentumParameters.volatilityWindowSessions }, (_, returnIndex) => {
        const currentIndex = volatilityStartIndex + returnIndex
        return universe.reduce(
          (sum, symbol) =>
            sum +
            (closeAt(currentIndex, symbol) / closeAt(currentIndex - 1, symbol) - 1) * (targetWeights[symbol] as number),
          0,
        )
      })
      const estimatedAnnualizedPortfolioVolatility = quantize(
        Math.sqrt(sampleVariance(portfolioReturns) * momentumParameters.annualizationSessions),
      )
      return {
        ...decision,
        estimatedAnnualizedPortfolioVolatility,
        exposureScale: quantize(Object.values(targetWeights).reduce((sum, weight) => sum + weight, 0)),
        targetWeights,
        signals: decision.signals.map((signal) => {
          const totalReturn = totalReturns[signal.symbol] as number
          const targetWeight = targetWeights[signal.symbol] as number
          return {
            ...signal,
            horizons: [
              {
                horizonSessions: momentumParameters.lookbackSessions,
                return: totalReturn,
                normalizedTrend: totalReturn,
              },
            ],
            dailyVolatility: 0,
            annualizedVolatility: selectedSymbol === signal.symbol ? estimatedAnnualizedPortfolioVolatility : 0,
            compositeScore: totalReturn,
            positiveScore: Math.max(0, totalReturn),
            eligible: selectedSymbol === signal.symbol,
            uncappedWeight: targetWeight,
            cappedWeight: targetWeight,
            targetWeight,
          }
        }),
      }
    })
    const momentumPlan: CandidateDevelopmentStrategyPlan = { ...plan, decisions: momentumDecisions }
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        momentumPlan,
        inputManifest,
        momentumRuntimeInput,
        momentumStrategyProtocol,
      ),
    ).toMatchObject({ success: { baseline: { schemaVersion: 'bayn.evaluation.v6' } } })
    const momentumFirstDecision = momentumPlan.decisions[0]
    if (momentumFirstDecision === undefined) throw new Error('candidate momentum plan requires one decision')
    const forgedMomentumSignals = momentumFirstDecision.signals.map((signal) => {
      if (signal.symbol === 'EFA') {
        return { ...signal, eligible: true, uncappedWeight: 0.2, cappedWeight: 0.2, targetWeight: 0.2 }
      }
      if (signal.symbol === 'SPY') {
        return { ...signal, eligible: false, uncappedWeight: 0, cappedWeight: 0, targetWeight: 0 }
      }
      return signal
    })
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...momentumPlan,
          decisions: [
            {
              ...momentumFirstDecision,
              targetWeights: { ...momentumFirstDecision.targetWeights, EFA: 0.2, SPY: 0 },
              signals: forgedMomentumSignals,
            },
            ...momentumPlan.decisions.slice(1),
          ],
        },
        inputManifest,
        momentumRuntimeInput,
        momentumStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].momentumSelection' },
      },
    })
    const forgedMomentumHorizonSignals = momentumFirstDecision.signals.map((signal) =>
      signal.symbol === 'SPY'
        ? {
            ...signal,
            horizons: [{ ...signal.horizons[0], return: signal.horizons[0].return + 0.01 }],
          }
        : signal,
    )
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...momentumPlan,
          decisions: [
            { ...momentumFirstDecision, signals: forgedMomentumHorizonSignals },
            ...momentumPlan.decisions.slice(1),
          ],
        },
        inputManifest,
        momentumRuntimeInput,
        momentumStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].signals[3].momentum' },
      },
    })
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...momentumPlan,
          decisions: [
            {
              ...momentumFirstDecision,
              estimatedAnnualizedPortfolioVolatility:
                momentumFirstDecision.estimatedAnnualizedPortfolioVolatility + 0.01,
            },
            ...momentumPlan.decisions.slice(1),
          ],
        },
        inputManifest,
        momentumRuntimeInput,
        momentumStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions[0].momentumVolatility' },
      },
    })
    const forgedMomentumVolatilitySignals = momentumFirstDecision.signals.map((signal) =>
      signal.eligible
        ? { ...signal, dailyVolatility: 0.01, annualizedVolatility: signal.annualizedVolatility + 0.01 }
        : signal,
    )
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        {
          ...momentumPlan,
          decisions: [
            { ...momentumFirstDecision, signals: forgedMomentumVolatilitySignals },
            ...momentumPlan.decisions.slice(1),
          ],
        },
        inputManifest,
        momentumRuntimeInput,
        momentumStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: expect.stringContaining('momentum') },
      },
    })
    const planArtifactSource = `
      const plan = ${JSON.stringify(plan)}
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-plan-artifact.v1',
        inputManifest: ${JSON.stringify(inputManifest)},
        buildPlan: () => plan,
      }
    `
    const verifiedFiles: CandidateDevelopmentVerifiedSourceFiles = {
      schemaVersion: 'bayn.candidate-development-verified-source-files.v1',
      sourceRevision: runtimeInput.sourceRevision,
      modulePath: runtimeInput.modulePath,
      moduleBlobOid: runtimeInput.moduleBlobOid,
      moduleSha256: runtimeInput.moduleSha256,
      sourceManifestPath: runtimeInput.sourceManifestPath,
      sourceManifestBlobOid: runtimeInput.sourceManifestBlobOid,
      sourceManifestSha256: runtimeInput.sourceManifestSha256,
      sourceManifest,
    }
    const workerBuilt = await Effect.runPromise(
      executeCandidateDevelopmentArtifactRuntime(
        `data:text/javascript;base64,${Buffer.from(planArtifactSource).toString('base64')}`,
        verifiedFiles,
        strategyProtocol,
        runtimeInput,
      ),
    )
    const decisionProjection = (evaluation: CandidateDevelopmentCommandEvaluation) =>
      evaluation.baseline.signalDecisions.map(({ signalDate, executionDate, exposureScale, targetWeights }) => ({
        signalDate,
        executionDate,
        exposureScale,
        targetWeights,
      }))
    expect(decisionProjection(workerBuilt)).toEqual(decisionProjection(built))
    expect(workerBuilt.accounting.markedEquityReconciliation.exact).toBe(true)
    let rawMarketDataReads = 0
    const guardedRuntimeInput = { ...runtimeInput }
    Object.defineProperty(guardedRuntimeInput, 'marketData', {
      enumerable: true,
      get: () => {
        rawMarketDataReads += 1
        if (rawMarketDataReads > 1) throw new Error('raw runtime market data was reused after validation')
        return marketData
      },
    })
    const guardedBuilt = await Effect.runPromise(
      executeCandidateDevelopmentArtifactRuntime(
        `data:text/javascript;base64,${Buffer.from(planArtifactSource).toString('base64')}`,
        verifiedFiles,
        strategyProtocol,
        guardedRuntimeInput,
      ),
    )
    expect(decisionProjection(guardedBuilt)).toEqual(decisionProjection(built))
    expect(rawMarketDataReads).toBe(1)
    const nondeterministicSource = planArtifactSource
      .replace('const plan =', 'let invocation = 0\n      const plan =')
      .replace(
        'buildPlan: () => plan,',
        'buildPlan: () => ({ ...plan, decisions: invocation++ === 0 ? plan.decisions : plan.decisions.slice(1) }),',
      )
    expect(
      await Effect.runPromise(
        Effect.flip(
          executeCandidateDevelopmentArtifactRuntime(
            `data:text/javascript;base64,${Buffer.from(nondeterministicSource).toString('base64')}`,
            verifiedFiles,
            strategyProtocol,
            runtimeInput,
          ),
        ),
      ),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
      cause: { message: 'candidate artifact buildPlan must be deterministic' },
    })
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        { ...plan, decisions: plan.decisions.slice(1) },
        inputManifest,
        runtimeInput,
        strategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.plan.decisions.length' },
      },
    })
    const forgedManifest = {
      ...inputManifest,
      finalizedSnapshot: {
        ...inputManifest.finalizedSnapshot,
        publisherSourceRevision: '9'.repeat(40),
      },
    }
    expect(buildCandidateDevelopmentPlanEvaluation(plan, forgedManifest, runtimeInput, strategyProtocol)).toMatchObject(
      {
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: { field: 'artifact.inputManifest' },
        },
      },
    )
    const { hash: _, ...inputManifestWithoutHash } = inputManifest
    const mismatchedManifestMaterial = {
      ...inputManifestWithoutHash,
      bounds: {
        ...inputManifest.bounds,
        evaluationStart: officialSessions[geometryPreflight.selectedObservationStartIndex + 1] as IsoDate,
      },
    }
    const mismatchedManifest = {
      ...mismatchedManifestMaterial,
      hash: canonicalHashV1(mismatchedManifestMaterial),
    }
    const mismatchedMarketDataMaterial = {
      ...marketDataMaterial,
      inputManifestHash: mismatchedManifest.hash,
    }
    const mismatchedMarketData = {
      ...mismatchedMarketDataMaterial,
      contentHash: canonicalHashV1(mismatchedMarketDataMaterial),
    }
    const mismatchedStrategyProtocol = {
      ...strategyProtocol,
      marketData: {
        ...strategyProtocol.marketData,
        contentHash: mismatchedMarketData.contentHash,
      },
    }
    const mismatchedStrategyProtocolHash = canonicalHashV1(mismatchedStrategyProtocol)
    const mismatchedRuntimeInput = {
      ...runtimeInput,
      preflightInput: {
        ...runtimeInput.preflightInput,
        expectedStrategyProtocolHash: mismatchedStrategyProtocolHash,
      },
      sourceManifest: {
        ...runtimeInput.sourceManifest,
        strategyProtocolHash: mismatchedStrategyProtocolHash,
        marketData: {
          ...runtimeInput.sourceManifest.marketData,
          inputManifestHash: mismatchedManifest.hash,
          boundedContentHash: mismatchedMarketData.contentHash,
        },
      },
      marketData: mismatchedMarketData,
    }
    expect(
      buildCandidateDevelopmentPlanEvaluation(
        plan,
        mismatchedManifest,
        mismatchedRuntimeInput,
        mismatchedStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'artifact.inputManifest.bounds.evaluationStart' },
      },
    })
  }, 60_000)
})
