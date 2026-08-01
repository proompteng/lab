import { describe, expect, test } from 'bun:test'
import {
  bindCandidateDevelopmentVerifiedSource,
  canonicalHashV1,
  evaluateCandidateDevelopmentArtifact,
  executeCandidateDevelopmentArtifactRuntime,
  type CandidateDevelopmentStrategyProtocol,
  type CandidateDevelopmentVerifiedSource,
  validateCandidateDevelopmentExecutableProgram,
  validateCandidateDevelopmentRuntimeMarketData,
} from './test-api'
import { Effect, Result, access, join, mkdtemp, pathToFileURL, rm, writeFile } from './test-runtime'
import {
  baselineFixture,
  commandEvaluationFixture,
  execFileResultPromise,
  fixtureInputManifest,
  fixtureMarketBars,
  fixtureMarketData,
  fixtureMarketDataMaterial,
  fixtureRuntimePreflightInput,
  fixtureStrategyProtocol,
  fixtureVerifiedSource,
  fixtureVerifiedSourceFiles,
  frozenSourceInput,
  frozenSourceStrategyProtocol,
  frozenSourceStructuralBindings,
  frozenSourceVerifiedSourceFiles,
  reportFixture,
  successOf,
  syntheticFrozenSourceRuntime,
} from './test-support'

describe('candidate development artifact plan', () => {
  test('loads a plan artifact definition through the executable-program boundary', async () => {
    const source = `
      const universe = ${JSON.stringify(frozenSourceStrategyProtocol.universe)}
      const zeroWeights = Object.fromEntries(universe.map((symbol) => [symbol, 0]))
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-plan-artifact.v1',
        input: ${JSON.stringify(frozenSourceInput)},
        strategyProtocol: ${JSON.stringify(frozenSourceStrategyProtocol)},
        structuralBindings: ${JSON.stringify(frozenSourceStructuralBindings)},
        inputManifest: ${JSON.stringify(fixtureInputManifest)},
        buildPlan: (runtimeInput) => {
          const sessions = runtimeInput.preflightInput.officialSessions
          const selectedStart = sessions[sessions.length - 504]
          const schedule = runtimeInput.preflightInput.signalSessionDates.flatMap((signalDate) => {
            const signalIndex = sessions.indexOf(signalDate)
            const executionDate = sessions[signalIndex + 1]
            return executionDate !== undefined && executionDate >= selectedStart
              ? [{ signalDate, executionDate }]
              : []
          })
          return {
            schemaVersion: 'bayn.candidate-development-strategy-plan.v1',
            decisions: schedule.map(({ signalDate, executionDate }) => ({
              schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
              signalDate,
              executionDate,
              covarianceWindow: {
                returnCount: 1,
                firstSession: signalDate,
                lastSession: signalDate,
                sessionsHash: 'a'.repeat(64),
              },
              estimatedAnnualizedPortfolioVolatility: 0,
              exposureScale: 0,
              targetWeights: zeroWeights,
              signals: universe.map((symbol) => ({
                symbol,
                horizons: [{ horizonSessions: 1, return: 0, normalizedTrend: 0 }],
                dailyVolatility: 0,
                annualizedVolatility: 0,
                compositeScore: 0,
                positiveScore: 0,
                eligible: false,
                uncappedWeight: 0,
                cappedWeight: 0,
                targetWeight: 0,
              })),
            })),
          }
        },
      }
    `
    const loaded = await Effect.runPromise(
      evaluateCandidateDevelopmentArtifact(
        `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
        frozenSourceVerifiedSourceFiles,
      ),
    )
    const program = successOf(
      validateCandidateDevelopmentExecutableProgram(
        (loaded as { readonly candidateDevelopmentProgram?: unknown }).candidateDevelopmentProgram,
      ),
    )
    expect(program.input).toEqual(frozenSourceInput)
    expect(program.strategyProtocol).toEqual(frozenSourceStrategyProtocol)
  }, 60_000)

  test('rejects dummy runtime reads when the returned evaluation keeps embedded provenance', async () => {
    const input = frozenSourceInput
    const verifiedSource = successOf(bindCandidateDevelopmentVerifiedSource(frozenSourceVerifiedSourceFiles, input))
    const report = reportFixture(0.01)
    const baseEvaluation = commandEvaluationFixture(report, baselineFixture())
    const embeddedSourceRevision = 'f'.repeat(40)
    const embeddedBaselineRunId = 'e'.repeat(64)
    const embeddedStressedRunId = 'd'.repeat(64)
    const embeddedEvaluation = {
      ...baseEvaluation,
      baseline: {
        ...baseEvaluation.baseline,
        runId: embeddedBaselineRunId,
        codeRevision: embeddedSourceRevision,
      },
      accounting: {
        ...baseEvaluation.accounting,
        runId: embeddedBaselineRunId,
        stressedRunId: embeddedStressedRunId,
      },
    }
    const source = `
      const embeddedEvaluation = ${JSON.stringify(embeddedEvaluation)}
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(frozenSourceStrategyProtocol)},
        structuralBindings: ${JSON.stringify(frozenSourceStructuralBindings)},
        buildEvaluation: (runtimeInput) => {
          void runtimeInput.sourceRevision
          void runtimeInput.baselineRunId
          void runtimeInput.stressedRunId
          return embeddedEvaluation
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
    const failure = await Effect.runPromise(
      Effect.flip(
        executeCandidateDevelopmentArtifactRuntime(
          moduleUrl,
          runtime.verifiedFiles,
          runtime.strategyProtocol,
          runtime.runtimeInput,
        ),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'verifiedSource.codeRevision',
        expected: verifiedSource.sourceRevision,
        observed: embeddedSourceRevision,
      },
    })
  })

  test('loads content-verified runtime market data into an artifact without embedding bars', async () => {
    const runtimeMarketData = fixtureMarketData
    const verifiedSource = fixtureVerifiedSource
    expect(
      validateCandidateDevelopmentRuntimeMarketData(
        runtimeMarketData,
        verifiedSource,
        fixtureStrategyProtocol,
        fixtureRuntimePreflightInput,
      ),
    ).toEqual(Result.succeed(runtimeMarketData))
    const firstBar = runtimeMarketData.bars[0]
    if (firstBar === undefined) throw new Error('runtime market-data regression requires one bar')
    const tamperedMarketData = {
      ...runtimeMarketData,
      bars: [{ ...firstBar, volume: firstBar.volume + 1 }, ...runtimeMarketData.bars.slice(1)],
    }
    expect(
      validateCandidateDevelopmentRuntimeMarketData(
        tamperedMarketData,
        verifiedSource,
        fixtureStrategyProtocol,
        fixtureRuntimePreflightInput,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-runtime-market-data',
        cause: { field: 'runtimeMarketData.recomputedContentHash' },
      },
    })

    const expectStructuralRejectionBeforeArtifact = async (
      bars: readonly (typeof fixtureMarketBars)[number][],
      expectedField?: string,
    ): Promise<void> => {
      const material = { ...fixtureMarketDataMaterial, bars }
      const contentHash = canonicalHashV1(material)
      const marketData = { ...material, contentHash }
      const structuralVerifiedSource: CandidateDevelopmentVerifiedSource = {
        ...verifiedSource,
        sourceManifest: {
          ...verifiedSource.sourceManifest,
          marketData: { ...verifiedSource.sourceManifest.marketData, boundedContentHash: contentHash },
        },
      }
      const structuralProtocol: CandidateDevelopmentStrategyProtocol = {
        ...fixtureStrategyProtocol,
        marketData: { ...fixtureStrategyProtocol.marketData, contentHash },
      }
      const failure = await Effect.runPromise(
        Effect.flip(
          executeCandidateDevelopmentArtifactRuntime(
            'artifact-must-not-be-loaded',
            fixtureVerifiedSourceFiles,
            structuralProtocol,
            {
              ...structuralVerifiedSource,
              runtimeDataSchemaVersion: 'bayn.candidate-development-artifact-runtime-input.v1',
              preflightInput: fixtureRuntimePreflightInput,
              marketData,
            },
          ),
        ),
      )
      expect(failure).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-runtime-market-data',
        ...(expectedField === undefined ? {} : { cause: { field: expectedField } }),
      })
    }
    const secondBar = runtimeMarketData.bars[1]
    if (secondBar === undefined) throw new Error('runtime market-data regression requires two bars')
    await expectStructuralRejectionBeforeArtifact(
      [firstBar, firstBar, ...runtimeMarketData.bars.slice(2)],
      'runtimeMarketData.bars[1].symbol',
    )
    await expectStructuralRejectionBeforeArtifact(
      [secondBar, firstBar, ...runtimeMarketData.bars.slice(2)],
      'runtimeMarketData.bars[0].symbol',
    )
    await expectStructuralRejectionBeforeArtifact(
      [{ ...firstBar, symbol: 'QQQ' as never }, ...runtimeMarketData.bars.slice(1)],
      'runtimeMarketData.bars[0].symbol',
    )
    const barsPerSession = fixtureStrategyProtocol.universe.length
    await expectStructuralRejectionBeforeArtifact(
      runtimeMarketData.bars.slice(barsPerSession),
      'runtimeMarketData.bars.length',
    )
    const finalSessionBars = runtimeMarketData.bars.slice(-barsPerSession)
    await expectStructuralRejectionBeforeArtifact(
      [...runtimeMarketData.bars, ...finalSessionBars],
      'runtimeMarketData.bars.length',
    )
    await expectStructuralRejectionBeforeArtifact([
      firstBar,
      { ...secondBar, publicationSchemaVersion: 'signal.adjusted-daily-snapshot.v1' as never },
      ...runtimeMarketData.bars.slice(2),
    ])

    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-runtime-data-'))
    const marketDataPath = join(directory, 'market-data.json')
    const processPath = join(directory, 'load-runtime-data.ts')
    try {
      await writeFile(marketDataPath, `${JSON.stringify(runtimeMarketData)}\n`)
      const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
      await writeFile(
        processPath,
        `import { Effect } from 'effect'
         import { loadCandidateDevelopmentRuntimeMarketDataFile } from ${JSON.stringify(commandUrl)}
         const verifiedSource = ${JSON.stringify(verifiedSource)}
         const strategyProtocol = ${JSON.stringify(fixtureStrategyProtocol)}
         const preflightInput = ${JSON.stringify(fixtureRuntimePreflightInput)}
         const value = await Effect.runPromise(
           loadCandidateDevelopmentRuntimeMarketDataFile(${JSON.stringify(marketDataPath)})(
             verifiedSource,
             strategyProtocol,
             preflightInput,
           ),
         )
         process.stdout.write(JSON.stringify({ contentHash: value.contentHash, barCount: value.bars.length }))
        `,
      )
      const processResult = await execFileResultPromise(process.execPath, [processPath], import.meta.dir)
      expect(processResult).toEqual({
        exitCode: 0,
        stdout: JSON.stringify({ contentHash: runtimeMarketData.contentHash, barCount: runtimeMarketData.bars.length }),
        stderr: '',
      })

      const baseEvaluation = commandEvaluationFixture(reportFixture(0.01), baselineFixture())
      const { marketData: _embeddedMarketData, ...evaluationWithoutMarketData } = baseEvaluation
      const source = `
        const evaluation = ${JSON.stringify(evaluationWithoutMarketData)}
        export const candidateDevelopmentArtifact = {
          schemaVersion: 'bayn.candidate-development-artifact.v1',
          strategyProtocol: ${JSON.stringify(frozenSourceStrategyProtocol)},
          structuralBindings: ${JSON.stringify(frozenSourceStructuralBindings)},
          buildEvaluation: (runtimeInput) => ({
            ...evaluation,
            baseline: {
              ...evaluation.baseline,
              runId: runtimeInput.baselineRunId,
              codeRevision: runtimeInput.sourceRevision,
            },
            accounting: {
              ...evaluation.accounting,
              runId: runtimeInput.baselineRunId,
              stressedRunId: runtimeInput.stressedRunId,
            },
            marketData: runtimeInput.marketData,
          }),
        }
      `
      expect(source).not.toContain(JSON.stringify(firstBar))
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
      let runtimeLoads = 0
      const loaded = await Effect.runPromise(
        evaluateCandidateDevelopmentArtifact(moduleUrl, frozenSourceVerifiedSourceFiles, () => {
          runtimeLoads += 1
          return Effect.succeed(runtimeMarketData)
        }),
      )
      const program = successOf(
        validateCandidateDevelopmentExecutableProgram(
          (loaded as { readonly candidateDevelopmentProgram?: unknown }).candidateDevelopmentProgram,
        ),
      )
      expect(program.input).toEqual(frozenSourceInput)
      expect(runtimeLoads).toBe(0)
      expect(
        await Effect.runPromise(
          Effect.flip(program.effects.loadDevelopmentData(undefined as never, undefined as never)),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-runtime-market-data',
        cause: {
          field: 'runtimeMarketData.bars.length',
          expected: frozenSourceInput.officialSessions.length * frozenSourceStrategyProtocol.universe.length,
          observed: runtimeMarketData.bars.length,
        },
      })
      expect(runtimeLoads).toBe(1)
      const frozenSourceVerifiedSource = successOf(
        bindCandidateDevelopmentVerifiedSource(frozenSourceVerifiedSourceFiles, frozenSourceInput),
      )
      const runtime = syntheticFrozenSourceRuntime(frozenSourceVerifiedSource)
      const decoded = await Effect.runPromise(
        executeCandidateDevelopmentArtifactRuntime(
          moduleUrl,
          runtime.verifiedFiles,
          runtime.strategyProtocol,
          runtime.runtimeInput,
        ),
      )
      expect(decoded.marketData).toEqual(runtimeMarketData)
      expect(decoded.baseline.codeRevision).toBe(frozenSourceVerifiedSource.sourceRevision)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    expect(
      await access(directory).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
  }, 60_000)
})
