import type { InferenceCostSnapshot } from '../inference-costs-postgres'
import type { OperationalRegistration } from './operational-period'
import type { SystemRegistration } from './policy'

export const captureInferenceSnapshot = (
  snapshot: InferenceCostSnapshot,
  program: SystemRegistration['program'] | OperationalRegistration['program'],
) => {
  const { requests, ...scope } = snapshot.evidence
  const evidence =
    program === 'BAYN_OPERATIONAL_RELIABILITY'
      ? null
      : {
          ...scope,
          requests: requests.map(
            ({ requestSchemaVersion: _version, sourceFingerprint: _fingerprint, stages: _stages, ...source }) => source,
          ),
        }
  return {
    evidence,
    source: {
      accountBindingHash: scope.accountBindingHash,
      sessionDate: scope.sessionDate,
      asOf: scope.asOf,
      requests: requests.map(
        ({ requestId, cycleId, authorityGenerationHash, requestSchemaVersion, sourceFingerprint }) => ({
          requestId,
          cycleId,
          authorityGenerationHash,
          requestSchemaVersion,
          sourceFingerprint,
        }),
      ),
      quotes: snapshot.quotes,
    },
  }
}
