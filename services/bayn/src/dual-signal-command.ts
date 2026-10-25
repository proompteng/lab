import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Effect, FileSystem, Layer, Logger, Stdio, Stream } from 'effect'

import { DualSignalError, evaluateDualSignalResearch, VisualDecisionClientLive } from './jev/dual-signal'
import { JevClientLive } from './jev/client'
import { JevHttpClientLive } from './jev/http'
import { decodeJevEvaluationRequest } from './jev/evidence'

export const dualSignalCommandUsage =
  'Usage: bayn-dual-signal --request <sealed-jev-evaluation-request.json> --output <private-new-report.json> | --help'

export const runDualSignalCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const print = (line: unknown) =>
      Stream.run(Stream.make(new TextEncoder().encode(`${JSON.stringify(line)}\n`)), stdio.stdout())
    if (args.length === 1 && args[0] === '--help') return yield* print({ usage: dualSignalCommandUsage })
    if (args.length !== 4 || args[0] !== '--request' || args[2] !== '--output')
      return yield* new DualSignalError({ message: dualSignalCommandUsage, category: 'INPUT' })
    const [requestPath, outputPath] = [args[1], args[3]]
    if (
      requestPath === undefined ||
      outputPath === undefined ||
      requestPath.length === 0 ||
      outputPath.length === 0 ||
      requestPath === outputPath
    )
      return yield* new DualSignalError({ message: 'Distinct input and output paths required', category: 'INPUT' })
    const fs = yield* FileSystem.FileSystem
    // Refuse an already occupied destination before any provider work; the final wx write still prevents races.
    if (yield* fs.exists(outputPath))
      return yield* new DualSignalError({ message: 'Output path already exists', category: 'INPUT' })
    if ((yield* fs.stat(requestPath)).size > 128n * 1024n)
      return yield* new DualSignalError({ message: 'Sealed Jev request exceeds 128 KiB', category: 'INPUT' })
    const json = yield* fs.readFileString(requestPath)
    const sealed = yield* Effect.try({
      try: (): unknown => JSON.parse(json),
      catch: (cause) => new DualSignalError({ message: 'Request is not JSON', category: 'INPUT', cause }),
    })
    const evaluated = yield* Effect.fromResult(decodeJevEvaluationRequest(sealed)).pipe(
      Effect.mapError(
        (cause) =>
          new DualSignalError({ message: 'Input is not a sealed Jev evaluation request', category: 'INPUT', cause }),
      ),
    )
    const jevKey = yield* Config.Redacted('BAYN_JEV_API_KEY')
    const openAiKey = yield* Config.Redacted('BAYN_OPENAI_API_KEY')
    const proxy = yield* Config.NonEmptyString('BAYN_PUBLIC_INFORMATION_PROXY')
    const http = JevHttpClientLive(proxy)
    const providers = Layer.merge(
      JevClientLive(jevKey, 8_000).pipe(Layer.provide(http)),
      VisualDecisionClientLive(openAiKey, 8_000).pipe(Layer.provide(http)),
    )
    const report = yield* evaluateDualSignalResearch(evaluated.request, evaluated.symbol).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- single-use scoped research CLI entrypoint.
      Effect.provide(providers),
    )
    yield* fs.writeFileString(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    yield* print({
      outputPath,
      reportHash: report.reportHash,
      comparison: report.comparison.status,
      coverage: report.costs.coverage,
      tradingAuthority: report.tradingAuthority,
    })
    if (report.costs.coverage !== 'PROVIDER_METERED' || report.comparison.status === 'INCOMPLETE')
      return yield* new DualSignalError({
        message: 'Incomplete provider comparison; partial report retained',
        category: 'PROVIDER',
      })
  }).pipe(Effect.scoped)

if (import.meta.main)
  NodeRuntime.runMain(
    runDualSignalCommand(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- NodeRuntime entrypoint.
      Effect.provide(Layer.merge(NodeServices.layer, Logger.layer([Logger.consoleJson]))),
      Effect.tapCause((cause) => Effect.logError(cause)),
    ),
  )
