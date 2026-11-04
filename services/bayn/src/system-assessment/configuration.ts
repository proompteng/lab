import { Result, Schema } from 'effect'
import type { LoadedRuntimeConfig } from '../config/model'
import { canonicalHashV1Result } from '../hash'
import { HistoricalJevProtocolSchema, type JevProtocol } from '../jev/protocol'
import { jevSignalIntervalMs } from '../jev/observation-query'
import { PositiveIntegerSchema, Sha256Schema } from '../schemas'
import { MarketKind } from '../instruments'
import { currentEntryMarkets } from '../execution/trading-scope'
import { executionControllerPlanHash } from '../execution/controller'
import { SystemAssessmentError } from './economics'

/** Only operational settings and public strategy parameters are retained; credentials and endpoints are excluded. */
export const QualificationRuntimeSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-runtime.v1'),
  controllerPlanHash: Schema.NullOr(Sha256Schema),
  cyclePollIntervalMs: PositiveIntegerSchema,
  operationTimeoutMs: PositiveIntegerSchema,
  reconciliationIntervalMs: PositiveIntegerSchema,
  reconciliationStaleThresholdMs: PositiveIntegerSchema,
  unknownMutationThresholdMs: PositiveIntegerSchema,
  protocol: HistoricalJevProtocolSchema,
  // Earlier financial registrations retain their original, unscoped runtime hash.
  entryMarkets: Schema.optionalKey(
    Schema.Array(Schema.Enum(MarketKind)).check(Schema.isMinLength(1), Schema.isUnique()),
  ),
})

export const qualificationRuntime = (
  config: LoadedRuntimeConfig,
  protocol: JevProtocol,
): Omit<typeof QualificationRuntimeSchema.Type, 'protocol'> & { readonly protocol: JevProtocol } => ({
  schemaVersion: 'bayn.qualification-runtime.v1',
  controllerPlanHash: executionControllerPlanHash,
  cyclePollIntervalMs: config.cyclePollIntervalMs,
  operationTimeoutMs: config.operationTimeoutMs,
  reconciliationIntervalMs: config.alpaca.reconciliationIntervalMs,
  reconciliationStaleThresholdMs: config.reconciliationStaleThresholdMs,
  unknownMutationThresholdMs: config.unknownMutationThresholdMs,
  protocol,
  entryMarkets: currentEntryMarkets,
})

export const qualificationDeadlines = (runtime: typeof QualificationRuntimeSchema.Type) =>
  Result.gen(function* () {
    return {
      runtimeConfigurationHash: yield* canonicalHashV1Result(runtime),
      decisionIntervalMs: jevSignalIntervalMs,
      decisionWindowMs: runtime.protocol.maximumDecisionLagMs,
      reconciliationIntervalMs: runtime.reconciliationIntervalMs,
      reconciliationFreshnessMs: runtime.reconciliationStaleThresholdMs,
      mutationDeadlineMs: runtime.operationTimeoutMs,
      recoveryDeadlineMs: runtime.unknownMutationThresholdMs,
    }
  })

export const captureQualificationRuntime = (
  runtime: typeof QualificationRuntimeSchema.Type,
  registered: {
    readonly configuration: typeof QualificationRuntimeSchema.Type
    readonly runtimeConfigurationHash: string
  },
) =>
  Result.gen(function* () {
    // Capture has already verified the persisted registration. Unknown historical plans stay unknown.
    const retainedPlanRuntime =
      registered.configuration.controllerPlanHash === null ? { ...runtime, controllerPlanHash: null } : runtime
    const { entryMarkets: _entryMarkets, ...unscopedRuntime } = retainedPlanRuntime
    const runtimeConfiguration: typeof QualificationRuntimeSchema.Type =
      registered.configuration.entryMarkets === undefined ? unscopedRuntime : retainedPlanRuntime
    const runtimeConfigurationHash = yield* canonicalHashV1Result(runtimeConfiguration)
    if (runtimeConfigurationHash !== registered.runtimeConfigurationHash)
      return yield* Result.fail(
        new SystemAssessmentError({
          message: 'Capture runtime differs from the prospectively registered configuration',
        }),
      )
    return { runtimeConfiguration, runtimeConfigurationHash }
  })
