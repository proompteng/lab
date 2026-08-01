import { describe, expect, test } from 'bun:test'
import { join, mkdtemp, pathToFileURL, rm, writeFile } from './test-runtime'
import { execFileResultPromise } from './test-support'

describe('candidate development failure validation', () => {
  test('preserves command validation payloads and canonical failure paths without arbitrary data', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-command-validation-'))
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const cases = [
      {
        name: 'performance-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
          series: 'strategy',
          reason: 'return-mismatch',
          index: 2,
          field: 'netReturn',
          expected: 0.125,
          observed: 0.25,
          secret: 'must-not-render',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
          reason: 'return-mismatch',
          series: 'strategy',
          field: 'netReturn',
          index: 2,
          expected: 0.125,
          observed: 0.25,
        },
      },
      {
        name: 'performance-signed-zero-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
          series: 'strategy',
          reason: 'metrics-mismatch',
          index: null,
          field: 'annualizedReturn',
          expected: 0,
          observed: -0,
          secret: 'must-not-render',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
          reason: 'metrics-mismatch',
          series: 'strategy',
          field: 'annualizedReturn',
          index: null,
          expected: 0,
          observed: '-0',
        },
      },
      {
        name: 'performance-calculation-operand',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
          series: 'strategy',
          reason: 'metrics-failed',
          index: 3,
          field: 'equityMicros',
          expected: null,
          observed: null,
          cause: {
            _tag: 'InvalidPerformanceInput',
            reason: 'invalid-equity',
            index: 3,
            value: Number.POSITIVE_INFINITY,
            secret: 'must-not-render',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
          reason: 'metrics-failed',
          series: 'strategy',
          field: 'equityMicros',
          index: 3,
          expected: null,
          observed: null,
          cause: {
            _tag: 'InvalidPerformanceInput',
            reason: 'invalid-equity',
            index: 3,
            value: 'Infinity',
          },
        },
      },
      {
        name: 'simulation-unexpected-bar-symbol',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'reconstruction-failed',
          index: null,
          field: 'marketData.bars',
          expected: 'governed universe',
          observed: null,
          cause: {
            _tag: 'UnexpectedBarSymbol',
            symbol: 'QQQ',
            universe: ['IEF', 'SPY'],
            secret: 'must-not-render',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'reconstruction-failed',
          field: 'marketData.bars',
          index: null,
          expected: 'governed universe',
          observed: null,
          cause: {
            _tag: 'UnexpectedBarSymbol',
            symbol: 'QQQ',
            universe: ['IEF', 'SPY'],
          },
        },
      },
      {
        name: 'simulation-incomplete-session',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'reconstruction-failed',
          index: 7,
          field: 'marketData.sessions',
          expected: 'complete governed session',
          observed: null,
          cause: {
            _tag: 'IncompleteSession',
            sessionDate: '2020-01-31',
            expectedSymbols: ['IEF', 'SPY'],
            observedSymbols: ['SPY'],
            secret: 'must-not-render',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'reconstruction-failed',
          field: 'marketData.sessions',
          index: 7,
          expected: 'complete governed session',
          observed: null,
          cause: {
            _tag: 'IncompleteSession',
            sessionDate: '2020-01-31',
            expectedSymbols: ['IEF', 'SPY'],
            observedSymbols: ['SPY'],
          },
        },
      },
      {
        name: 'marked-equity-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          index: 4,
          field: 'baseline.dailyMarks.priceMicros',
          expected: 'governed mark session',
          observed: '2020-01-31',
          token: 'must-not-render',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          field: 'baseline.dailyMarks.priceMicros',
          index: 4,
          expected: 'governed mark session',
          observed: '2020-01-31',
        },
      },
      {
        name: 'cash-yield-order-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          index: 5,
          field: 'baseline.cashYield.order',
          expected: 'before every same-session fill and fee',
          observed: { index: 2, kind: 'fee', secret: 'must-not-render' },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          field: 'baseline.cashYield.order',
          index: 5,
          expected: 'before every same-session fill and fee',
          observed: { index: 2, kind: 'fee' },
        },
      },
      {
        name: 'marked-equity-indexed-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'selected-trace-mismatch',
          index: null,
          field: 'baselineSimulation.dailyMarks[3]',
          expected: '${'a'.repeat(64)}',
          observed: '${'b'.repeat(64)}',
          token: 'must-not-render',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'selected-trace-mismatch',
          field: 'baselineSimulation.dailyMarks[3]',
          index: null,
          expected: 'a'.repeat(64),
          observed: 'b'.repeat(64),
        },
      },
      {
        name: 'marked-equity-symbol-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          index: null,
          field: 'benchmarks.symbol',
          expected: ['IEF', 'SPY'],
          observed: 'QQQ',
          secret: 'must-not-render',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          field: 'benchmarks.symbol',
          index: null,
          expected: ['IEF', 'SPY'],
          observed: 'QQQ',
        },
      },
      {
        name: 'marked-equity-terminal-target-weights',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          index: 7,
          field: 'benchmarks.terminalDecision',
          expected: 'all-cash target weights',
          observed: { SPY: 0.5 },
          secret: 'must-not-render',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          field: 'benchmarks.terminalDecision',
          index: 7,
          expected: 'all-cash target weights',
          observed: { SPY: 0.5 },
        },
      },
      {
        name: 'marked-equity-order-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          index: 3,
          field: 'marketData.bars.order',
          expected: 'strict session-date/symbol order',
          observed: {
            previous: { sessionDate: '2020-01-31', symbol: 'SPY' },
            current: { sessionDate: '2020-01-30', symbol: 'IEF' },
          },
          secret: 'must-not-render',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'binding-mismatch',
          field: 'marketData.bars.order',
          index: 3,
          expected: 'strict session-date/symbol order',
          observed: {
            current: { sessionDate: '2020-01-30', symbol: 'IEF' },
            previous: { sessionDate: '2020-01-31', symbol: 'SPY' },
          },
        },
      },
      {
        name: 'marked-equity-position-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'selected-trace-mismatch',
          index: 0,
          field: 'baseline.predecessor.positions',
          expected: 'all-zero positions',
          observed: {
            symbol: 'SPY',
            quantityMicros: '0',
            costBasisMicros: '1000000',
            priceMicros: '500000000',
            marketValueMicros: '0',
            secret: 'must-not-render',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'selected-trace-mismatch',
          field: 'baseline.predecessor.positions',
          index: 0,
          expected: 'all-zero positions',
          observed: {
            costBasisMicros: '1000000',
            marketValueMicros: '0',
            priceMicros: '500000000',
            quantityMicros: '0',
            symbol: 'SPY',
          },
        },
      },
      {
        name: 'marked-equity-reconciliation-problem',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'reconstruction-failed',
          index: null,
          field: 'accounting',
          expected: 'reconciled marked equity',
          observed: null,
          cause: [{
            _tag: 'EvidenceMismatch',
            problem: {
              _tag: 'FillTerms',
              fillId: '${'c'.repeat(64)}',
              field: 'notionalMicros',
              actualMicros: '1000001',
              expectedMicros: '1000000',
              secret: 'must-not-render',
            },
          }, {
            _tag: 'InvalidInteger',
            expected: 'unsigned-integer',
            evidence: {
              kind: 'order',
              orderId: '${'d'.repeat(64)}',
              field: 'requestedQuantityMicros',
              value: 'not-integer',
              secret: 'must-not-render',
            },
          }, {
            _tag: 'InvalidIdentity',
            evidence: {
              kind: 'decision',
              id: '${'e'.repeat(64)}',
              signalDate: '2020-01-31',
              secret: 'must-not-render',
            },
            problem: {
              _tag: 'HashMismatch',
              expected: '${'f'.repeat(64)}',
              secret: 'must-not-render',
            },
          }, {
            _tag: 'ComputationFailed',
            computation: {
              _tag: 'FillTerms',
              fillId: '${'1'.repeat(64)}',
              side: 'buy',
              quantityMicros: '1000000',
              referencePriceMicros: '500000000',
              costMultiplierMicros: '2000000',
              secret: 'must-not-render',
            },
            cause: {
              _tag: 'InvalidFillTerms',
              side: 'buy',
              quantityMicros: 1000000n,
              referencePriceMicros: 500000000n,
              costMultiplierMicros: 2000000n,
              reason: 'costs-consume-reference-price',
              secret: 'must-not-render',
            },
          }, {
            _tag: 'ComputationFailed',
            computation: {
              _tag: 'CashYield',
              cashYieldId: '${'2'.repeat(64)}',
              cashMicros: '1000000',
              elapsedDays: 1,
              annualYieldBps: 500,
              secret: 'must-not-render',
            },
            cause: {
              _tag: 'InvalidCashAccrualPeriod',
              from: '2020-02-01',
              to: '2020-01-31',
              secret: 'must-not-render',
            },
          }],
          token: 'must-not-render',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'reconstruction-failed',
          field: 'accounting',
          index: null,
          expected: 'reconciled marked equity',
          observed: null,
          cause: [
            {
              _tag: 'EvidenceMismatch',
              problem: {
                _tag: 'FillTerms',
                fillId: 'c'.repeat(64),
                field: 'notionalMicros',
                actualMicros: '1000001',
                expectedMicros: '1000000',
              },
            },
            {
              _tag: 'InvalidInteger',
              expected: 'unsigned-integer',
              evidence: {
                kind: 'order',
                orderId: 'd'.repeat(64),
                field: 'requestedQuantityMicros',
                value: 'not-integer',
              },
            },
            {
              _tag: 'InvalidIdentity',
              evidence: {
                kind: 'decision',
                id: 'e'.repeat(64),
                signalDate: '2020-01-31',
              },
              problem: {
                _tag: 'HashMismatch',
                expected: 'f'.repeat(64),
              },
            },
            {
              _tag: 'ComputationFailed',
              computation: {
                _tag: 'FillTerms',
                fillId: '1'.repeat(64),
                side: 'buy',
                quantityMicros: '1000000',
                referencePriceMicros: '500000000',
                costMultiplierMicros: '2000000',
              },
              cause: {
                _tag: 'InvalidFillTerms',
                side: 'buy',
                quantityMicros: '1000000',
                referencePriceMicros: '500000000',
                costMultiplierMicros: '2000000',
                reason: 'costs-consume-reference-price',
              },
            },
            {
              _tag: 'ComputationFailed',
              computation: {
                _tag: 'CashYield',
                cashYieldId: '2'.repeat(64),
                cashMicros: '1000000',
                elapsedDays: 1,
                annualYieldBps: 500,
              },
              cause: {
                _tag: 'InvalidCashAccrualPeriod',
                from: '2020-02-01',
                to: '2020-01-31',
              },
            },
          ],
        },
      },
      {
        name: 'marked-equity-reconciliation-prefix',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'reconstruction-failed',
          index: null,
          field: 'accounting',
          expected: 'reconciled marked equity',
          observed: null,
          cause: Array.from({ length: 10 }, () => ({
            _tag: 'IncompleteEvidence',
            problem: {
              _tag: 'EmptyDailyMarks',
              secret: 'must-not-render',
            },
            secret: 'must-not-render',
          })),
          token: 'must-not-render',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
          reason: 'reconstruction-failed',
          field: 'accounting',
          index: null,
          expected: 'reconciled marked equity',
          observed: null,
          cause: {
            items: Array.from({ length: 8 }, () => ({
              _tag: 'IncompleteEvidence',
              problem: { _tag: 'EmptyDailyMarks' },
            })),
            omittedCount: 2,
          },
        },
      },
      {
        name: 'economic-gate-mismatch',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandEconomicGateInvalid',
          index: 1,
          expected: { name: 'annualized_return', passed: true, actual: '0.10', required: '>=0.05' },
          observed: { name: 'annualized_return', passed: false, actual: '0.01', required: '>=0.05' },
          timestamp: '2026-07-31T18:00:00.000Z',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandEconomicGateInvalid',
          index: 1,
          expected: { actual: '0.10', name: 'annualized_return', passed: true, required: '>=0.05' },
          observed: { actual: '0.01', name: 'annualized_return', passed: false, required: '>=0.05' },
        },
      },
      {
        name: 'canonical-json-path',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandHashFailed',
          cause: {
            _tag: 'CanonicalJsonFailure',
            path: '$.report.metrics.sharpe',
            reason: 'non-finite-number',
            actualType: 'number',
            secret: 'must-not-render',
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandHashFailed',
          cause: {
            _tag: 'CanonicalJsonFailure',
            reason: 'non-finite-number',
            actualType: 'number',
            path: '$.report.metrics.sharpe',
          },
        },
      },
    ] as const

    try {
      const results: Array<
        | undefined
        | {
            readonly testCase: (typeof cases)[number]
            readonly result: Awaited<ReturnType<typeof execFileResultPromise>>
          }
      > = Array.from({ length: cases.length })
      let nextCaseIndex = 0
      const workerCount = Math.min(4, cases.length)
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (true) {
            const caseIndex = nextCaseIndex
            nextCaseIndex += 1
            const testCase = cases[caseIndex]
            if (testCase === undefined) return

            const scriptPath = join(directory, `${testCase.name}.ts`)
            const script = `
import { Effect } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}

runCandidateDevelopmentCommandMain(Effect.fail(${testCase.failureExpression}))
`
            await writeFile(scriptPath, script)
            results[caseIndex] = {
              testCase,
              result: await execFileResultPromise(process.execPath, [scriptPath], import.meta.dir),
            }
          }
        }),
      )

      for (const completed of results) {
        if (completed === undefined) throw new Error('command validation worker did not complete every case')
        const { result, testCase } = completed
        const expected = `${JSON.stringify({
          schemaVersion: 'bayn.candidate-development-command-failure.v1',
          error: {
            _tag: 'CandidateDevelopmentCommandError',
            failure: testCase.expectedFailure,
          },
        })}\n`

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe(expected)
        expect(result.stderr).not.toContain('must-not-render')
        expect(result.stderr).not.toContain('/workspace/')
        expect(result.stderr).not.toContain('2026-07-31')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('preserves module and nested qualification diagnostics without arbitrary data', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-nested-diagnostics-'))
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const cases = [
      {
        name: 'module-load-path',
        failureExpression: `{
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/strategy/example/candidate.ts',
          cause: {
            _tag: 'CandidateDevelopmentModuleDecodeFailed',
            reason: 'invalid-shape',
            secret: 'must-not-render',
          },
          path: '/workspace/private/candidate.ts',
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
          modulePath: 'services/bayn/src/strategy/example/candidate.ts',
          cause: {
            _tag: 'CandidateDevelopmentModuleDecodeFailed',
            reason: 'invalid-shape',
          },
        },
      },
      {
        name: 'qualification-series-alignment',
        failureExpression: `{
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonSeriesProjectionFailed',
            cause: {
              _tag: 'QualificationSeriesAlignmentFailed',
              reason: 'missing-buy-and-hold-observation',
              sessionDate: '2020-01-31',
              strategyCount: 12,
              buyAndHoldCount: 11,
              directVolatilityCount: 12,
              token: 'must-not-render',
            },
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonSeriesProjectionFailed',
            cause: {
              _tag: 'QualificationSeriesAlignmentFailed',
              reason: 'missing-buy-and-hold-observation',
              sessionDate: '2020-01-31',
              strategyCount: 12,
              buyAndHoldCount: 11,
              directVolatilityCount: 12,
            },
          },
        },
      },
      {
        name: 'qualification-lineage',
        failureExpression: `{
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonAnalysisFailed',
            cause: {
              _tag: 'QualificationLineageInvalid',
              priorTrialRunIds: [
                '${'0'.repeat(64)}',
                '${'1'.repeat(64)}',
                '${'2'.repeat(64)}',
                '${'3'.repeat(64)}',
                '${'4'.repeat(64)}',
                '${'5'.repeat(64)}',
                '${'6'.repeat(64)}',
                '${'7'.repeat(64)}',
                '${'8'.repeat(64)}',
                '${'9'.repeat(64)}',
              ],
              secret: 'must-not-render',
            },
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonAnalysisFailed',
            cause: {
              _tag: 'QualificationLineageInvalid',
              priorTrialRunIds: {
                items: [
                  '0'.repeat(64),
                  '1'.repeat(64),
                  '2'.repeat(64),
                  '3'.repeat(64),
                  '4'.repeat(64),
                  '5'.repeat(64),
                  '6'.repeat(64),
                  '7'.repeat(64),
                ],
                omittedCount: 2,
              },
            },
          },
        },
      },
      {
        name: 'qualification-walk-forward-boundary',
        failureExpression: `{
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonAnalysisFailed',
            cause: {
              _tag: 'QualificationWalkForwardBoundaryMissing',
              testStart: 10,
              testSessions: 5,
              observationCount: 12,
              timestamp: '2026-07-31T18:00:00.000Z',
            },
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonAnalysisFailed',
            cause: {
              _tag: 'QualificationWalkForwardBoundaryMissing',
              testStart: 10,
              testSessions: 5,
              observationCount: 12,
            },
          },
        },
      },
      {
        name: 'qualification-date-order',
        failureExpression: `{
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonSeriesProjectionFailed',
            cause: {
              _tag: 'QualificationDateOrderInvalid',
              previous: '2020-02-03',
              current: '2020-01-31',
              secret: 'must-not-render',
            },
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonSeriesProjectionFailed',
            cause: {
              _tag: 'QualificationDateOrderInvalid',
              previous: '2020-02-03',
              current: '2020-01-31',
            },
          },
        },
      },
      {
        name: 'qualification-statistic-not-finite',
        failureExpression: `{
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonAnalysisFailed',
            cause: {
              _tag: 'QualificationStatisticNotFinite',
              operation: 'power',
              value: Number.NaN,
              secret: 'must-not-render',
            },
          },
        }`,
        expectedFailure: {
          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
          cause: {
            _tag: 'CandidateDevelopmentComparisonAnalysisFailed',
            cause: {
              _tag: 'QualificationStatisticNotFinite',
              operation: 'power',
              value: 'NaN',
            },
          },
        },
      },
    ] as const

    try {
      for (const testCase of cases) {
        const scriptPath = join(directory, `${testCase.name}.ts`)
        const script = `
import { Effect } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}

runCandidateDevelopmentCommandMain(Effect.fail(${testCase.failureExpression}))
`
        await writeFile(scriptPath, script)
        const result = await execFileResultPromise(process.execPath, [scriptPath], import.meta.dir)
        const expected = `${JSON.stringify({
          schemaVersion: 'bayn.candidate-development-command-failure.v1',
          error: {
            _tag: 'CandidateDevelopmentCommandError',
            failure: testCase.expectedFailure,
          },
        })}\n`

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe(expected)
        expect(result.stderr).not.toContain('must-not-render')
        expect(result.stderr).not.toContain('/workspace/')
        expect(result.stderr).not.toContain('2026-07-31')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
