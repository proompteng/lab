import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Path, Schema, Stdio, Stream } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../src/hash'
import { decodeEquityEdgeInput, decodeEquityEdgeSource } from '../src/intraday-replay/equity-edge-source'
import {
  EquityScreenError,
  equityEarlyScreenPolicies,
  equityRiskScreenPolicies,
  equityScreenPolicies,
  runEquityEdgeScreen,
  type EquityScreenPolicy,
} from '../src/intraday-replay/equity-edge-screen'

const maximumSourceBytes = 128 * 1024 * 1024
export const equityEdgeScreenUsage =
  'Usage: bayn-equity-edge-screen --input input.json --input-sha256 <sha256> --source pages.ndjson --output new-report.json | --help'
const policyIdentity = (policy: EquityScreenPolicy) =>
  `${policy.signal}:${policy.holdingMinutes}:${policy.volatilityRisk === true ? 'volatility' : 'fixed'}`

export const equityEdgeScreenProgram = (args: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (
        args.length !== 8 ||
        args[0] !== '--input' ||
        args[2] !== '--input-sha256' ||
        args[4] !== '--source' ||
        args[6] !== '--output'
      )
        return yield* new EquityScreenError({
          message:
            'Usage: equity-edge-screen --input input.json --input-sha256 <sha256> --source pages.ndjson --output new-report.json',
        })
      const inputPath = args[1],
        expectedInputHash = args[3],
        sourcePath = args[5],
        outputPath = args[7]
      if (
        inputPath === undefined ||
        inputPath === '' ||
        expectedInputHash === undefined ||
        expectedInputHash === '' ||
        sourcePath === undefined ||
        sourcePath === '' ||
        outputPath === undefined ||
        outputPath === ''
      )
        return yield* new EquityScreenError({ message: 'Paths and input hash must be nonempty' })
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const inputInfo = yield* fs.stat(inputPath)
      const sourceInfo = yield* fs.stat(sourcePath)
      if (inputInfo.size > 1024 * 1024 || sourceInfo.size > maximumSourceBytes)
        return yield* new EquityScreenError({ message: 'Offline research input exceeded its byte bound' })
      const inputText = yield* fs.readFileString(inputPath)
      if (sha256(inputText) !== expectedInputHash)
        return yield* new EquityScreenError({ message: 'Input SHA-256 mismatch' })
      const raw = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(inputText)
      const input = yield* Effect.fromResult(decodeEquityEdgeInput(raw))
      if (yield* fs.exists(outputPath))
        return yield* new EquityScreenError({ message: 'Report destination already exists' })
      const sourceText = yield* fs.readFileString(sourcePath)
      const source = yield* Effect.fromResult(decodeEquityEdgeSource(sourceText, input))
      const policies = [...equityScreenPolicies, ...equityRiskScreenPolicies, ...equityEarlyScreenPolicies]
      const evaluate = (policy: EquityScreenPolicy, period: { start: string; end: string }) =>
        Effect.fromResult(
          runEquityEdgeScreen(source.index, input.symbols, source.days, period.start, period.end, policy),
        )
      const development = yield* Effect.forEach(policies, (policy) => evaluate(policy, input.development), {
        concurrency: 1,
      })
      const developmentStress = yield* Effect.forEach(
        policies,
        (policy) => evaluate({ ...policy, adverseBpsPerSide: 20 }, input.development),
        { concurrency: 1 },
      )
      const ranked = development
        .filter((r) => r.status === 'COMPLETED' && r.executionNetPnlMicros !== null)
        .sort(
          (a, b) =>
            Number(BigInt(b.executionNetPnlMicros ?? '0') - BigInt(a.executionNetPnlMicros ?? '0')) ||
            policyIdentity(a.policy).localeCompare(policyIdentity(b.policy), 'en'),
        )
      const best = ranked[0]
      const selectedPolicy = best !== undefined && BigInt(best.executionNetPnlMicros ?? '0') > 0n ? best.policy : null
      // The selector sees development only. Later outcomes never revise its identity.
      const selection = {
        policy: selectedPolicy,
        developmentReportHash: yield* Effect.fromResult(canonicalHashV1Result(development)),
        trialCount: policies.length,
      }
      const later = yield* Effect.forEach(
        ['validation', 'holdout'] as const,
        (partition) =>
          Effect.gen(function* () {
            const results = yield* Effect.forEach(
              policies,
              (policy) =>
                Effect.gen(function* () {
                  const base = yield* evaluate(policy, input[partition])
                  const stress = yield* evaluate({ ...policy, adverseBpsPerSide: 20 }, input[partition])
                  return { policy, base, stress }
                }),
              { concurrency: 1 },
            )
            return { partition, results }
          }),
        { concurrency: 1 },
      )
      const selectedResults =
        selectedPolicy === null
          ? []
          : later.map((partition) => ({
              partition: partition.partition,
              result:
                partition.results.find((r) => policyIdentity(r.policy) === policyIdentity(selectedPolicy)) ?? null,
            }))
      const positiveInEveryLaterScenario =
        selectedResults.length === 2 &&
        selectedResults.every(
          ({ result }) =>
            result !== null &&
            [result.base, result.stress].every(
              (r) =>
                r.status === 'COMPLETED' &&
                r.trades.length > 0 &&
                r.executionNetPnlMicros !== null &&
                BigInt(r.executionNetPnlMicros) > 0n,
            ),
        )
      const report = {
        schemaVersion: 'bayn.equity-edge-screen-report.v3',
        inputHash: expectedInputHash,
        input,
        source: source.source,
        coverage: source.coverage,
        selection,
        development,
        developmentStress,
        later,
        selectedResults,
        decision: positiveInEveryLaterScenario
          ? 'REQUIRES_NATIVE_EXECUTION_AND_PROSPECTIVE_VALIDATION'
          : 'REJECT_FOR_PROMOTION',
        qualified: false,
        allInProfit: null,
        limits: [
          'Retrospective bar-based scenarios, not actual fills or a native portfolio replay',
          'Contemporary fixed universe; historical survivor and selection bias remain',
          'Missing candidate windows exclude decisions; missing benchmark, entry-pricing or held-position bars invalidate the entire path',
          'Minute-completion stops can cross stops before the next observation; gap losses are not clipped',
          'Quotes, order book depth, live price limits, partial fills, market impact, and original arrival timing are not reproduced',
          'Native current execution fees are scenario assumptions; historical fee tariffs are not reconstructed',
          'Infrastructure, inference, and market-data costs remain unknown',
          'Each temporal partition starts at the same capital; partition P&Ls are not one continuous portfolio',
          'Positive historical outputs never activate a strategy or grant capital authority',
        ],
      }
      const text = yield* Effect.fromResult(canonicalJsonV1Result(report))
      yield* fs.makeDirectory(paths.dirname(outputPath), { recursive: true, mode: 0o700 })
      const file = yield* fs.open(outputPath, { flag: 'wx', mode: 0o600 })
      yield* file.writeAll(new TextEncoder().encode(`${text}\n`))
      yield* file.sync
      return {
        outputPath,
        reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)),
        sourceSha256: input.sourceSha256,
        selection,
        decision: report.decision,
        qualified: false,
        selectedResults: selectedResults.map(({ partition, result }) => ({
          partition,
          baseExecutionNetPnlMicros: result?.base.executionNetPnlMicros ?? null,
          stressExecutionNetPnlMicros: result?.stress.executionNetPnlMicros ?? null,
        })),
      }
    }),
  )

export const equityEdgeScreenCli = (args: readonly string[]) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] === '--help') {
      const stdio = yield* Stdio.Stdio
      return yield* Stream.run(Stream.make(`${equityEdgeScreenUsage}\n`), stdio.stdout())
    }
    const receipt = yield* equityEdgeScreenProgram(args)
    yield* Effect.logInfo('Offline equity screen completed').pipe(Effect.annotateLogs(receipt))
  })

if (import.meta.main)
  NodeRuntime.runMain(
    equityEdgeScreenCli(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline command owns filesystem and standard output only
      Effect.provide(NodeServices.layer),
    ),
  )
