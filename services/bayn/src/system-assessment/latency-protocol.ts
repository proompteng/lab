import { Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { Sha256Schema } from '../schemas'
import { ReplayImagePlatform } from './replay-image-platform'

export const LatencyStressSourcesSchema = Schema.Array(
  Schema.Struct({
    policy: Schema.Enum(JevResearchPolicy),
    inputFileHash: Sha256Schema,
    captureFileHash: Sha256Schema,
    reportFileHash: Sha256Schema,
    costsFileHash: Sha256Schema,
    imagePlatform: Schema.NullOr(Schema.Enum(ReplayImagePlatform)),
    executionReceiptHash: Schema.NullOr(Sha256Schema),
  }),
)

export const systemLatencyStressProtocol = {
  schemaVersion: 'bayn.system-latency-stress-protocol.v3',
  calibration: 'COMPLETE_REGISTERED_FULL_BATCH_DURATIONS',
  calibrationPolicy: JevResearchPolicy.Candidate,
  controlIntervention: 'SAME_CALIBRATED_FLOOR_WITH_OWN_ACTUAL_COMPLETION',
  percentile: 'EMPIRICAL_NEAREST_RANK_95',
  anchor: 'ORIGINAL_CONTROLLER_COMMAND',
  intervention: 'DECISION_INFORMATION_RELEASE_FLOOR',
  releaseRule: 'MAX_ACTUAL_COMPLETION_AND_COMMAND_PLUS_P95',
  retainSlowerWork: true,
  preserveOriginalExpiry: true,
  recheckPricingAndRiskAfterRelease: true,
  retainDownstreamRoutingAndRecovery: true,
  inference: 'EXACT_RETAINED_REQUEST_RESPONSES_ONLY',
  unsupportedCounterfactual: 'INCONCLUSIVE',
  profitabilityMonotoneInLatency: false,
} as const

export const systemLatencyStressProtocolHash = () => canonicalHashV1Result(systemLatencyStressProtocol)

/** New registrations bind the actual engine and its event-driven information availability. */
export const strategyBoundSystemLatencyStressProtocol = {
  ...systemLatencyStressProtocol,
  schemaVersion: 'bayn.system-latency-stress-protocol.v4',
  calibration: 'COMPLETE_REGISTERED_NATIVE_DECISION_DURATIONS',
  strategyBinding: 'EXPLICIT_COMPLETE_ENGINE_POLICY',
  scheduling: 'RETAINED_SOURCE_AVAILABILITY_AND_NATIVE_DEADLINES',
  alphaBaseline: 'SAME_SESSION_STRICTLY_PRIOR_DAYS_WITH_INDEPENDENT_DURABLE_WITNESS',
  sourceFailures: 'INCOMPLETE_WITHOUT_FABRICATED_AVAILABILITY',
} as const

export const strategyBoundSystemLatencyStressProtocolHash = () =>
  canonicalHashV1Result(strategyBoundSystemLatencyStressProtocol)

/** Preparation availability is established before the original command by an independent committed witness. */
export const preparedAlphaSystemLatencyStressProtocol = {
  ...strategyBoundSystemLatencyStressProtocol,
  schemaVersion: 'bayn.system-latency-stress-protocol.v5',
  alphaBaseline: 'STANDALONE_SESSION_PREPARATION_WITH_INDEPENDENT_COMMITTED_WITNESS',
  alphaBaselineAdmission: 'WITNESSED_BEFORE_ORIGINAL_COMMAND_WITHOUT_PROVIDER_FALLBACK',
  alphaBaselineScope: 'EXACT_POLICY_PROVIDER_SESSION_AND_PHYSICAL_PRODUCER',
} as const

export const preparedAlphaSystemLatencyStressProtocolHash = () =>
  canonicalHashV1Result(preparedAlphaSystemLatencyStressProtocol)
