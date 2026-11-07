import { Clock, Effect, Redacted, Result } from 'effect'

import { embeddedBuildMetadata } from '../build'
import { utcInstantFromEpochMillis } from '../time'
import { makeNativeChartEvidence } from './chart-evidence'
import { JevClient } from './client'
import { jevModel } from './contract'
import { deriveEntryHandoffDisposition } from './entry-inference'
import { prepareEntryInferenceInput } from './entry-inference-input'
import { defaultJevProtocolDocument } from './protocol'
import { makeInitialChartStageRequest } from './staged-chart-questions'

export const boxAcceptanceCases = [
  {
    name: 'base-breakout',
    closes: [
      105, 104, 103, 102, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100,
      101, 100, 101, 100, 101, 102, 102,
    ],
  },
  {
    name: 'support-recovery',
    closes: [
      106, 104, 102, 100, 98, 100, 102, 104, 106, 104, 102, 100, 98, 100, 102, 104, 106, 104, 102, 100, 98, 100, 102,
      104, 106, 104, 102, 100, 98, 100,
    ],
  },
  { name: 'uninterrupted-trend', closes: Array.from({ length: 30 }, (_, i) => 100 + i) },
]

/** Exercises real inference and source derivation without acquiring trading authority or issuing broker operations. */
export const verifyBoxAcceptance = Effect.gen(function* () {
  const client = yield* JevClient
  const cases = yield* Effect.forEach(boxAcceptanceCases, (scenario) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      const end = Math.floor(started / 60_000) * 60_000
      const latest = scenario.closes.at(-1)
      if (latest === undefined) throw new Error('Box acceptance requires a nonempty scenario')
      const bars = scenario.closes.map((close, index) => {
        const open = scenario.closes[index - 1] ?? close
        return {
          minuteBeforeWindowEnd: scenario.closes.length - index,
          open,
          close,
          high: Math.max(open, close) + 0.2,
          low: Math.min(open, close) - 0.2,
          volume: 1000,
        }
      })
      const windowEndAt = utcInstantFromEpochMillis(end)
      const prepared = yield* Effect.fromResult(
        prepareEntryInferenceInput({
          schemaVersion: 'bayn.entry-inference-input.v8',
          numericalState: {
            schemaVersion: defaultJevProtocolDocument.inputDefinition,
            webullContext: null,
            entryEconomics: { maximumEntryQuoteDriftBps: 0, maximumEntryLimitSlippageBps: 0 },
            task: { decisionPurpose: 'ENTRY' },
            candidate: { symbol: 'AAPL', bars1m: bars },
            session: { completedBarWindowEndsAt: windowEndAt },
          },
          chartSource: { symbol: 'AAPL', windowEndAt, bars },
          protocol: defaultJevProtocolDocument,
          funding: {
            bidMicros: String(BigInt(latest) * 1_000_000n),
            askMicros: String(BigInt(latest) * 1_000_000n + 10_000n),
            capitalMicros: '5000000000',
            cryptoFeeTier: null,
          },
        }),
      )
      const chart = yield* Effect.fromResult(makeNativeChartEvidence(prepared.input.chartSource))
      const request = yield* Effect.fromResult(
        makeInitialChartStageRequest({ chart, protocol: prepared.input.protocol, funding: prepared.input.funding }),
      )
      const visual = yield* client
        .evaluate(request.request, 10_000 - ((yield* Clock.currentTimeMillis) - started))
        .pipe(Effect.result)
      if (Result.isFailure(visual)) {
        const raw =
          visual.failure.rejectedResponse === undefined ? null : Redacted.value(visual.failure.rejectedResponse)
        const answers =
          raw !== null &&
          typeof raw === 'object' &&
          'answers' in raw &&
          raw.answers !== null &&
          typeof raw.answers === 'object'
            ? raw.answers
            : {}
        const boxes = Object.fromEntries(
          ['support_region', 'resistance_region', 'base_region'].map((name) => {
            const answer: unknown = name in answers ? Reflect.get(answers, name) : null
            const box =
              answer !== null &&
              typeof answer === 'object' &&
              'box' in answer &&
              answer.box !== null &&
              typeof answer.box === 'object'
                ? answer.box
                : {}
            return [
              name,
              Object.fromEntries(
                ['top', 'bottom', 'left', 'right'].flatMap((edge) => {
                  const value: unknown = Reflect.get(box, edge)
                  return typeof value === 'number' ? [[edge, value]] : []
                }),
              ),
            ]
          }),
        )
        return {
          name: scenario.name,
          status: 'FAILED' as const,
          stage: 'CHART',
          failure: visual.failure.message,
          httpStatus: visual.failure.status ?? null,
          boxes,
        }
      }
      const disposition = yield* Effect.fromResult(deriveEntryHandoffDisposition(prepared.input, visual.success))
      const remaining = 10_000 - ((yield* Clock.currentTimeMillis) - started)
      const decision =
        disposition.status === 'READY' && remaining > 0
          ? yield* client.evaluate(disposition.jevRequest, remaining).pipe(Effect.result)
          : null
      return {
        name: scenario.name,
        status:
          (decision !== null && Result.isFailure(decision)) || (disposition.status === 'READY' && decision === null)
            ? ('FAILED' as const)
            : ('COMPLETED' as const),
        chart: { barsHash: chart.barsHash, pngHash: chart.pngHash, source: prepared.input.chartSource },
        visual: visual.success,
        disposition,
        decision:
          decision === null
            ? null
            : Result.isSuccess(decision)
              ? decision.success
              : { failure: decision.failure.message, httpStatus: decision.failure.status ?? null },
        elapsedMs: (yield* Clock.currentTimeMillis) - started,
      }
    }),
  )
  const downstream = cases.filter((row) => 'decision' in row && row.decision !== null && 'response' in row.decision)
  const passed = cases.every((row) => row.status === 'COMPLETED') && downstream.length > 0
  return {
    sourceKind: 'DETERMINISTIC_ACCEPTANCE_FIXTURE' as const,
    schemaVersion: 'bayn.jev-box-acceptance.v1',
    status: passed ? ('PASS' as const) : ('FAIL' as const),
    model: jevModel,
    build: embeddedBuildMetadata ?? null,
    downstreamDecisions: downstream.length,
    cases,
  }
})
