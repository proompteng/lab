import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import { Authority, RiskOutcome } from '../paper'

export type PaperCandidateDiscoveryError =
  | { readonly _tag: 'IdentityDecodeFailed'; readonly failure: 'invalid-input'; readonly cause: unknown }
  | {
      readonly _tag: 'StrategyProtocolMismatch'
      readonly failure: 'invalid-input'
      readonly observedStrategyProtocolHash: string
      readonly expectedStrategyProtocolHash: string
    }
  | {
      readonly _tag: 'CycleUnfinished'
      readonly failure: 'cycle-unfinished'
      readonly unfinishedCycleCount: number
      readonly currentCycleId: string | null
    }
  | {
      readonly _tag: 'CycleMissing'
      readonly failure: 'cycle-missing'
      readonly source: 'projection'
      readonly cycleId: null
    }
  | {
      readonly _tag: 'CycleMissing'
      readonly failure: 'cycle-missing'
      readonly source: 'cycle-store'
      readonly cycleId: string
    }
  | { readonly _tag: 'DocumentMissing'; readonly failure: 'document-missing'; readonly cycleId: string }
  | {
      readonly _tag: 'SnapshotTransactionFailed'
      readonly failure: 'transaction'
      readonly accountId: string
      readonly qualificationRunId: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CycleStateMismatch'
      readonly failure: 'cycle-mismatch'
      readonly source: 'projection' | 'cycle-store'
      readonly observedState: string
    }
  | {
      readonly _tag: 'CycleTerminalAtMissing'
      readonly failure: 'cycle-mismatch'
      readonly cycleId: string
    }
  | {
      readonly _tag: 'CycleIdentityMismatch'
      readonly failure: 'cycle-mismatch'
      readonly expectedCycleId: string
      readonly observedCycleId: string
    }
  | {
      readonly _tag: 'CycleAccountMismatch'
      readonly failure: 'cycle-mismatch'
      readonly expectedAccountId: string
      readonly projectedAccountId: string
      readonly storedAccountId: string
    }
  | {
      readonly _tag: 'CycleQualificationMismatch'
      readonly failure: 'cycle-mismatch'
      readonly expectedQualificationRunId: string
      readonly observedQualificationRunId: string
    }
  | {
      readonly _tag: 'CycleStrategyMismatch'
      readonly failure: 'cycle-mismatch'
      readonly expectedStrategyProtocolHash: string
      readonly observedStrategyProtocolHash: string
    }
  | {
      readonly _tag: 'CycleChronologyMismatch'
      readonly failure: 'cycle-mismatch'
      readonly cycleId: string
      readonly projected: {
        readonly signalSessionDate: string
        readonly executionSessionDate: string
        readonly submissionOpenAt: string
        readonly submissionCutoffAt: string
        readonly executionOpenAt: string
        readonly executionCloseAt: string
        readonly terminalAt: string | null
      }
      readonly stored: {
        readonly signalSessionDate: string
        readonly executionSessionDate: string
        readonly submissionOpenAt: string
        readonly submissionCutoffAt: string
        readonly executionOpenAt: string
        readonly executionCloseAt: string
        readonly terminalAt: string
      }
    }
  | {
      readonly _tag: 'CycleBindingMissing'
      readonly failure: 'document-mismatch'
      readonly binding: 'snapshot' | 'decision'
      readonly cycleId: string
    }
  | {
      readonly _tag: 'SnapshotBindingMismatch'
      readonly failure: 'document-mismatch'
      readonly storedSnapshotId: string
      readonly projectedSnapshotId: string | null
      readonly documentSnapshotId: string
    }
  | {
      readonly _tag: 'DecisionBindingMismatch'
      readonly failure: 'document-mismatch'
      readonly storedDecisionHash: string
      readonly projectedDecisionHash: string | null
      readonly documentContentHash: string
    }
  | {
      readonly _tag: 'DocumentIdentityMismatch'
      readonly failure: 'document-mismatch'
      readonly expected: {
        readonly cycleId: string
        readonly accountId: string
        readonly strategyName: string
        readonly strategyProtocolHash: string
      }
      readonly observed: {
        readonly cycleId: string
        readonly accountId: string
        readonly strategyName: string
        readonly strategyProtocolHash: string
      }
    }
  | {
      readonly _tag: 'DocumentPolicyMismatch'
      readonly failure: 'document-mismatch'
      readonly expectedPolicyHash: string
      readonly observedPolicyHash: string
    }
  | {
      readonly _tag: 'TargetPlanUnavailable'
      readonly failure: 'document-mismatch'
      readonly status: string
      readonly intentTargetCount: number
    }
  | {
      readonly _tag: 'RiskCountMismatch'
      readonly failure: 'risk-mismatch'
      readonly deltaRiskCount: number
      readonly intentTargetCount: number
    }
  | {
      readonly _tag: 'DocumentCutoffMismatch'
      readonly failure: 'document-mismatch'
      readonly cycleSubmissionCutoffAt: string
      readonly documentSubmissionCutoffAt: string
      readonly documentExpiresAt: string
    }
  | {
      readonly _tag: 'DocumentStale'
      readonly failure: 'document-stale'
      readonly observedAtMs: number
      readonly expiresAt: string
    }
  | {
      readonly _tag: 'AuthorityMismatch'
      readonly failure: 'authority-mismatch'
      readonly expectedGenerationHash: string
      readonly observedGenerationHash: string | null
      readonly observedMaximum: Authority | null
      readonly observedEffective: Authority | null
    }
  | {
      readonly _tag: 'RiskAuthorityMismatch'
      readonly failure: 'risk-mismatch'
      readonly index: number
      readonly outcome: RiskOutcome
      readonly reasonCodes: ReadonlyArray<string>
      readonly failedGates: ReadonlyArray<{ readonly name: string; readonly reason: string }>
    }
  | {
      readonly _tag: 'ReconciliationMissing'
      readonly failure: 'document-mismatch'
      readonly accountId: string
    }
  | {
      readonly _tag: 'ReconciliationMismatch'
      readonly failure: 'document-mismatch'
      readonly expectedAccountId: string
      readonly observedAccountId: string
      readonly expectedReconciliationId: string
      readonly observedReconciliationId: string
      readonly status: string
      readonly discrepancyCount: number
      readonly coversLatestMutation: boolean
    }
  | {
      readonly _tag: 'UnresolvedMutations'
      readonly failure: 'document-mismatch'
      readonly reconciliationId: string
      readonly unresolvedMutationCount: number
    }
  | {
      readonly _tag: 'BrokerReadFailed'
      readonly failure: 'broker'
      readonly read: 'account' | 'account-configuration'
      readonly accountId: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'BrokerReadFailed'
      readonly failure: 'broker'
      readonly read: 'assets'
      readonly accountId: string
      readonly symbols: ReadonlyArray<string>
      readonly cause: unknown
    }
  | {
      readonly _tag: 'AccountMismatch'
      readonly failure: 'account-mismatch'
      readonly expectedAccountId: string
      readonly observedAccountId: string
    }
  | {
      readonly _tag: 'ObservationTimeMismatch'
      readonly failure: 'broker'
      readonly observation: 'account' | 'account-configuration'
      readonly symbol: null
      readonly valueObservedAt: string
      readonly evidenceObservedAt: string
    }
  | {
      readonly _tag: 'ObservationTimeMismatch'
      readonly failure: 'broker'
      readonly observation: 'asset'
      readonly symbol: string
      readonly valueObservedAt: string
      readonly evidenceObservedAt: string
    }
  | {
      readonly _tag: 'ObservationChronologyMismatch'
      readonly failure: 'broker'
      readonly earlier: 'account'
      readonly later: 'account-configuration'
      readonly symbol: null
      readonly earlierObservedAt: string
      readonly laterObservedAt: string
    }
  | {
      readonly _tag: 'ObservationChronologyMismatch'
      readonly failure: 'broker'
      readonly earlier: 'account-configuration'
      readonly later: 'asset'
      readonly symbol: string
      readonly earlierObservedAt: string
      readonly laterObservedAt: string
    }
  | {
      readonly _tag: 'AssetMissing'
      readonly failure: 'broker'
      readonly ordinal: number
      readonly symbol: string
    }
  | {
      readonly _tag: 'AssetSymbolMismatch'
      readonly failure: 'broker'
      readonly ordinal: number
      readonly plannedSymbol: string
      readonly requestedSymbol: string
      readonly observedSymbol: string
    }
  | {
      readonly _tag: 'AssetCountMismatch'
      readonly failure: 'broker'
      readonly expectedAssetCount: number
      readonly observedAssetCount: number
    }
  | {
      readonly _tag: 'CandidateMaterialMissing'
      readonly failure: 'document-mismatch'
      readonly material: 'intent' | 'target'
      readonly ordinal: number
      readonly symbol: string | null
    }
  | {
      readonly _tag: 'CandidateMaterialMissing'
      readonly failure: 'risk-mismatch'
      readonly material: 'risk'
      readonly ordinal: number
      readonly symbol: string
    }
  | {
      readonly _tag: 'BindingHashFailed'
      readonly failure: 'output'
      readonly cycleId: string
      readonly documentContentHash: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateFactsDecodeFailed'
      readonly failure: 'output'
      readonly immutableBindingHash: string
      readonly candidateCount: number
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateFactsHashFailed'
      readonly failure: 'output'
      readonly immutableBindingHash: string
      readonly candidateCount: number
      readonly cause: unknown
    }
  | {
      readonly _tag: 'ReceiptHashFailed'
      readonly failure: 'output'
      readonly schemaVersion: string
      readonly candidateFactsHash: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'ReceiptDecodeFailed'
      readonly failure: 'output'
      readonly schemaVersion: string
      readonly candidateFactsHash: string
      readonly cause: unknown
    }

const paperCandidateDiscoveryErrorTags: ReadonlySet<string> = new Set([
  'IdentityDecodeFailed',
  'StrategyProtocolMismatch',
  'CycleUnfinished',
  'CycleMissing',
  'DocumentMissing',
  'SnapshotTransactionFailed',
  'CycleStateMismatch',
  'CycleTerminalAtMissing',
  'CycleIdentityMismatch',
  'CycleAccountMismatch',
  'CycleQualificationMismatch',
  'CycleStrategyMismatch',
  'CycleChronologyMismatch',
  'CycleBindingMissing',
  'SnapshotBindingMismatch',
  'DecisionBindingMismatch',
  'DocumentIdentityMismatch',
  'DocumentPolicyMismatch',
  'TargetPlanUnavailable',
  'RiskCountMismatch',
  'DocumentCutoffMismatch',
  'DocumentStale',
  'AuthorityMismatch',
  'RiskAuthorityMismatch',
  'ReconciliationMissing',
  'ReconciliationMismatch',
  'UnresolvedMutations',
  'BrokerReadFailed',
  'AccountMismatch',
  'ObservationTimeMismatch',
  'ObservationChronologyMismatch',
  'AssetMissing',
  'AssetSymbolMismatch',
  'AssetCountMismatch',
  'CandidateMaterialMissing',
  'BindingHashFailed',
  'CandidateFactsDecodeFailed',
  'CandidateFactsHashFailed',
  'ReceiptHashFailed',
  'ReceiptDecodeFailed',
])

export const isPaperCandidateDiscoveryError = (cause: unknown): cause is PaperCandidateDiscoveryError =>
  typeof cause === 'object' &&
  cause !== null &&
  '_tag' in cause &&
  typeof cause._tag === 'string' &&
  paperCandidateDiscoveryErrorTags.has(cause._tag)

export const renderPaperCandidateDiscoveryError = (error: PaperCandidateDiscoveryError): string => {
  switch (error._tag) {
    case 'IdentityDecodeFailed':
      return 'paper candidate identity decoding failed'
    case 'StrategyProtocolMismatch':
      return `paper candidate strategy protocol mismatch: expected=${error.expectedStrategyProtocolHash} observed=${error.observedStrategyProtocolHash}`
    case 'CycleUnfinished':
      return `paper candidate discovery requires zero unfinished cycles: count=${error.unfinishedCycleCount} current=${error.currentCycleId ?? 'none'}`
    case 'CycleMissing':
      return `paper candidate cycle is missing: source=${error.source} cycle=${error.cycleId ?? 'none'}`
    case 'DocumentMissing':
      return `paper candidate decision document is missing: cycle=${error.cycleId}`
    case 'SnapshotTransactionFailed':
      return `paper candidate read-only snapshot transaction failed: qualification=${error.qualificationRunId} account=${error.accountId}`
    case 'CycleStateMismatch':
      return `paper candidate cycle state mismatch: source=${error.source} observed=${error.observedState}`
    case 'CycleTerminalAtMissing':
      return `paper candidate completed cycle has no terminal timestamp: cycle=${error.cycleId}`
    case 'CycleIdentityMismatch':
      return `paper candidate cycle identity mismatch: expected=${error.expectedCycleId} observed=${error.observedCycleId}`
    case 'CycleAccountMismatch':
      return `paper candidate cycle account mismatch: expected=${error.expectedAccountId} projection=${error.projectedAccountId} stored=${error.storedAccountId}`
    case 'CycleQualificationMismatch':
      return `paper candidate cycle qualification mismatch: expected=${error.expectedQualificationRunId} observed=${error.observedQualificationRunId}`
    case 'CycleStrategyMismatch':
      return `paper candidate cycle strategy mismatch: expected=${error.expectedStrategyProtocolHash} observed=${error.observedStrategyProtocolHash}`
    case 'CycleChronologyMismatch':
      return `paper candidate cycle chronology mismatch: cycle=${error.cycleId} projection=${JSON.stringify(error.projected)} stored=${JSON.stringify(error.stored)}`
    case 'CycleBindingMissing':
      return `paper candidate cycle ${error.binding} binding is missing: cycle=${error.cycleId}`
    case 'SnapshotBindingMismatch':
      return `paper candidate snapshot binding mismatch: stored=${error.storedSnapshotId} projection=${error.projectedSnapshotId ?? 'none'} document=${error.documentSnapshotId}`
    case 'DecisionBindingMismatch':
      return `paper candidate decision binding mismatch: stored=${error.storedDecisionHash} projection=${error.projectedDecisionHash ?? 'none'} document=${error.documentContentHash}`
    case 'DocumentIdentityMismatch':
      return `paper candidate document identity mismatch: expected=${JSON.stringify(error.expected)} observed=${JSON.stringify(error.observed)}`
    case 'DocumentPolicyMismatch':
      return `paper candidate policy mismatch: expected=${error.expectedPolicyHash} observed=${error.observedPolicyHash}`
    case 'TargetPlanUnavailable':
      return `paper candidate target plan is unavailable: status=${error.status} intents=${error.intentTargetCount}`
    case 'RiskCountMismatch':
      return `paper candidate risk count mismatch: risks=${error.deltaRiskCount} intents=${error.intentTargetCount}`
    case 'DocumentCutoffMismatch':
      return `paper candidate cutoff mismatch: cycle=${error.cycleSubmissionCutoffAt} document=${error.documentSubmissionCutoffAt} expires=${error.documentExpiresAt}`
    case 'DocumentStale':
      return `paper candidate document is stale: observedMs=${error.observedAtMs} expires=${error.expiresAt}`
    case 'AuthorityMismatch':
      return `paper candidate authority mismatch: expectedGeneration=${error.expectedGenerationHash} observedGeneration=${error.observedGenerationHash ?? 'none'} maximum=${error.observedMaximum ?? 'none'} effective=${error.observedEffective ?? 'none'}`
    case 'RiskAuthorityMismatch':
      return `paper candidate risk ${error.index} is not blocked only by authority: outcome=${error.outcome} reasons=${error.reasonCodes.join(',')}`
    case 'ReconciliationMissing':
      return `paper candidate reconciliation is missing: account=${error.accountId}`
    case 'ReconciliationMismatch':
      return `paper candidate reconciliation mismatch: expectedAccount=${error.expectedAccountId} observedAccount=${error.observedAccountId} expectedId=${error.expectedReconciliationId} observedId=${error.observedReconciliationId}`
    case 'UnresolvedMutations':
      return `paper candidate unresolved mutations remain: reconciliation=${error.reconciliationId} count=${error.unresolvedMutationCount}`
    case 'BrokerReadFailed':
      return error.read === 'assets'
        ? `paper candidate broker assets read failed: account=${error.accountId} symbols=${error.symbols.join(',')}`
        : `paper candidate broker ${error.read} read failed: account=${error.accountId}`
    case 'AccountMismatch':
      return `paper candidate account mismatch: expected=${error.expectedAccountId} observed=${error.observedAccountId}`
    case 'ObservationTimeMismatch':
      return `paper candidate ${error.observation} evidence time mismatch: symbol=${error.symbol ?? 'none'} value=${error.valueObservedAt} evidence=${error.evidenceObservedAt}`
    case 'ObservationChronologyMismatch':
      return `paper candidate observation chronology mismatch: earlier=${error.earlier}:${error.earlierObservedAt} later=${error.later}:${error.laterObservedAt} symbol=${error.symbol ?? 'none'}`
    case 'AssetMissing':
      return `paper candidate asset observation is missing: ordinal=${error.ordinal} symbol=${error.symbol}`
    case 'AssetSymbolMismatch':
      return `paper candidate asset symbol mismatch: ordinal=${error.ordinal} planned=${error.plannedSymbol} requested=${error.requestedSymbol} observed=${error.observedSymbol}`
    case 'AssetCountMismatch':
      return `paper candidate asset count mismatch: expected=${error.expectedAssetCount} observed=${error.observedAssetCount}`
    case 'CandidateMaterialMissing':
      return `paper candidate ${error.material} is missing: ordinal=${error.ordinal} symbol=${error.symbol ?? 'none'}`
    case 'BindingHashFailed':
      return `paper candidate binding hash failed: cycle=${error.cycleId} document=${error.documentContentHash}`
    case 'CandidateFactsDecodeFailed':
      return `paper candidate facts decoding failed: binding=${error.immutableBindingHash} candidates=${error.candidateCount}`
    case 'CandidateFactsHashFailed':
      return `paper candidate facts hash failed: binding=${error.immutableBindingHash} candidates=${error.candidateCount}`
    case 'ReceiptHashFailed':
      return `paper candidate receipt hash failed: schema=${error.schemaVersion} facts=${error.candidateFactsHash}`
    case 'ReceiptDecodeFailed':
      return `paper candidate receipt decoding failed: schema=${error.schemaVersion} facts=${error.candidateFactsHash}`
  }
}

export const requireCondition = (
  condition: boolean,
  error: PaperCandidateDiscoveryError,
): Result.Result<void, PaperCandidateDiscoveryError> => (condition ? Result.succeed(undefined) : Result.fail(error))

export const requireValue = <A>(
  value: A | null | undefined,
  error: PaperCandidateDiscoveryError,
): Result.Result<A, PaperCandidateDiscoveryError> =>
  value === null || value === undefined ? Result.fail(error) : Result.succeed(value)

export const canonicalHashResult = (
  value: unknown,
  onFailure: (cause: unknown) => PaperCandidateDiscoveryError,
): Result.Result<string, PaperCandidateDiscoveryError> =>
  Result.try({
    try: () => canonicalHashV1(value),
    catch: onFailure,
  })
