import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Logger, Schema, Stdio, Stream } from 'effect'

import { loadApplicationPlan } from './application-plan'
import { embeddedBuildMetadata } from './build'
import { alpacaHttpLayer } from './broker/alpaca/http'
import { layer as brokerReadLayer, mapHttpAcquisitionError } from './broker/alpaca/session'
import {
  configuredCapitalActivation,
  readBoundCapitalActivationGeneration,
  validateResearchCapitalRiskPolicy,
} from './composition/capital-activation'
import { AuthorityGenerationStore, ExecutionStoreLive } from './db/execution-store'
import { PostgresClientLive } from './db/postgres-client'
import { WriterFenceLive } from './execution/writer-fence'
import { makeExecutionRiskPolicy } from './execution/risk-policy'
import { sha256 } from './hash'
import { ControlStudyPlanSchema } from './intraday-replay/control-binding'
import {
  captureControlStudyOpening,
  retainControlStudyOpening,
  verifyControlOpeningRuntime,
} from './intraday-replay/control-opening'
import { ControlStudyFailure } from './intraday-replay/control-portfolio'
import { defaultJevProtocolDocument } from './jev/protocol'
import { JournalLive } from './ledger'
import { runOnce } from './reconciler'
import { strictParseOptions } from './schemas'
import { currentUtcInstant } from './time'

export const controlOpeningUsage =
  'Usage: bayn-control-opening --plan <json> --plan-sha256 <sha256> --output <new-private-directory> | --help'

export const runControlOpeningCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const print = (value: string) => Stream.run(Stream.make(`${value}\n`), stdio.stdout())
    if (args.length === 1 && args[0] === '--help') return yield* print(controlOpeningUsage)
    const [planFlag, planPath, hashFlag, planHash, outputFlag, outputPath] = args
    if (
      args.length !== 6 ||
      planFlag !== '--plan' ||
      hashFlag !== '--plan-sha256' ||
      outputFlag !== '--output' ||
      planPath === undefined ||
      planPath.trim() === '' ||
      planPath.startsWith('--') ||
      planHash === undefined ||
      !/^[a-f0-9]{64}$/.test(planHash) ||
      outputPath === undefined ||
      outputPath.trim() === '' ||
      outputPath.startsWith('--')
    )
      return yield* new ControlStudyFailure({ message: controlOpeningUsage })
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(planPath)
    if (sha256(text) !== planHash) return yield* new ControlStudyFailure({ message: 'Frozen plan hash differs' })
    const frozen = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ControlStudyPlanSchema),
      strictParseOptions,
    )(text)
    if (embeddedBuildMetadata === undefined)
      return yield* new ControlStudyFailure({
        message: 'Opening capture requires the deployed embedded production build',
      })
    const application = yield* loadApplicationPlan
    const { config } = application
    const configured = yield* Effect.fromResult(configuredCapitalActivation(application))
    if (configured === null)
      return yield* new ControlStudyFailure({
        message: 'Opening capture requires the existing sealed candidate request',
      })
    yield* validateResearchCapitalRiskPolicy(application, configured.request)
    const policy = yield* Effect.fromResult(
      makeExecutionRiskPolicy(
        config.alpaca.expectedAccountId,
        defaultJevProtocolDocument.universe,
        config.alpaca.environment,
      ),
    )
    const { verification: _verification, ...build } = config.build
    const runtime = {
      broker: config.alpaca.identity,
      requestHash: configured.request.requestHash,
      build,
      policy,
    }
    // Reject another account, request, build or policy before acquiring external resources.
    yield* Effect.fromResult(verifyControlOpeningRuntime(frozen, runtime))
    const postgres = PostgresClientLive(config)
    const fence = WriterFenceLive.pipe(Layer.provide(postgres))
    const persistence = ExecutionStoreLive(config).pipe(
      Layer.provideMerge(fence),
      Layer.provide(JournalLive(config)),
      Layer.provideMerge(postgres),
    )
    const broker = brokerReadLayer(config.alpaca).pipe(
      Layer.provide(mapHttpAcquisitionError(config.alpaca, alpacaHttpLayer(config.alpaca))),
    )
    const capture = Effect.gen(function* () {
      const authority = yield* AuthorityGenerationStore
      return yield* captureControlStudyOpening(frozen, runtime, {
        readBoundGeneration: readBoundCapitalActivationGeneration(
          application,
          configured.request,
          configured.buildContinuation,
          configured.buildLineage,
          authority,
        ).pipe(Effect.map((generation) => generation.generationHash)),
        reconcile: runOnce,
        now: currentUtcInstant,
      })
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- capture owns and closes its native reconciliation clients before publishing files
      Effect.provide(Layer.merge(persistence, broker)),
      Effect.timeout(config.operationTimeoutMs),
    )
    const result = yield* retainControlStudyOpening(outputPath, planHash, capture)
    yield* print(JSON.stringify(result))
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runControlOpeningCommand(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => Effect.logError('Opening capture failed; no receipt means incomplete capture', cause)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- process entry point owns file and output services
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
