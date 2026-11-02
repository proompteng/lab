import { Result, Schema } from 'effect'
import type { LoadedRuntimeConfig } from '../config/model'
import { canonicalHashV1Result } from '../hash'
import { HistoricalJevProtocolSchema, type JevProtocol } from '../jev/protocol'
import { jevSignalIntervalMs } from '../jev/observation-query'
import { PositiveIntegerSchema, Sha256Schema } from '../schemas'

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
})

export const qualificationRuntime = (
  config: LoadedRuntimeConfig,
  protocol: JevProtocol,
): Omit<typeof QualificationRuntimeSchema.Type, 'protocol'> & { readonly protocol: JevProtocol } => ({
  schemaVersion: 'bayn.qualification-runtime.v1',
  controllerPlanHash: config.expectedExecutionControllerPlanHash ?? null,
  cyclePollIntervalMs: config.cyclePollIntervalMs,
  operationTimeoutMs: config.operationTimeoutMs,
  reconciliationIntervalMs: config.alpaca.reconciliationIntervalMs,
  reconciliationStaleThresholdMs: config.reconciliationStaleThresholdMs,
  unknownMutationThresholdMs: config.unknownMutationThresholdMs,
  protocol,
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
