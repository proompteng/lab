import { Result, Schema } from 'effect'
import type { LoadedRuntimeConfig } from '../config/model'
import { canonicalHashV1Result } from '../hash'
import { HistoricalJevProtocolSchema, type JevProtocol } from '../jev/protocol'
import { jevSignalIntervalMs } from '../jev/observation-query'
import { PositiveIntegerSchema, Sha256Schema } from '../schemas'
import { MarketKind } from '../instruments'
import { currentEntryMarkets } from '../execution/trading-scope'
import { SystemAssessmentError } from './economics'
import { executionControllerPlanHash } from '../execution/controller-plan'

const qualificationRuntimeFields = {
  controllerPlanHash: Schema.NullOr(Sha256Schema),
  operationTimeoutMs: PositiveIntegerSchema,
  reconciliationIntervalMs: PositiveIntegerSchema,
  reconciliationStaleThresholdMs: PositiveIntegerSchema,
  unknownMutationThresholdMs: PositiveIntegerSchema,
  protocol: HistoricalJevProtocolSchema,
  // Earlier financial registrations retain their original, unscoped runtime hash.
  entryMarkets: Schema.optionalKey(
    Schema.Array(Schema.Enum(MarketKind)).check(Schema.isMinLength(1), Schema.isUnique()),
  ),
}

/** Financial registrations retain their original polling assumptions and hashes. */
export const RetainedQualificationRuntimeSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-runtime.v1'),
  cyclePollIntervalMs: PositiveIntegerSchema,
  ...qualificationRuntimeFields,
})

/** Only operational settings and public strategy parameters are retained; credentials and endpoints are excluded. */
export const StreamingQualificationRuntimeSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-runtime.v2'),
  decisionTrigger: Schema.Literal('streaming'),
  ...qualificationRuntimeFields,
})

export const QualificationRuntimeSchema = Schema.Union([
  RetainedQualificationRuntimeSchema,
  StreamingQualificationRuntimeSchema,
])

export const qualificationRuntime = (
  config: LoadedRuntimeConfig,
  protocol: JevProtocol,
): Omit<typeof StreamingQualificationRuntimeSchema.Type, 'protocol'> & { readonly protocol: JevProtocol } => ({
  schemaVersion: 'bayn.qualification-runtime.v2',
  decisionTrigger: 'streaming',
  controllerPlanHash: executionControllerPlanHash,
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
    if (runtime.schemaVersion !== registered.configuration.schemaVersion)
      return yield* Result.fail(
        new SystemAssessmentError({
          message: 'Capture runtime differs from the prospectively registered decision trigger',
        }),
      )
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
