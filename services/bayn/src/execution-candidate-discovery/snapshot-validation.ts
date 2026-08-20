import { Result, Schema, pipe } from 'effect'

import { makeStrategyProtocolHashResult } from '../contracts'
import { cycleAuthoritySessionDate, CycleState } from '../cycle'
import type { CycleOperationsProjection } from '../cycle/observability'
import { Authority, RiskOutcome } from '../execution/contracts'
import { Gate, isAuthorityNotGrantedReason } from '../risk'
import { strictParseOptions } from '../schemas'
import type { ObserveShadowDecisionDocument } from '../shadow-decision-contract'
import { TargetPlanStatus } from '../target-planner'
import {
  RuntimeIdentitySchema,
  ValidatedSnapshotTypeId,
  bindingSchemaVersion,
  type ExecutionCandidateDiscoveryBinding,
  type ExecutionCandidateDiscoveryIdentity,
  type ExecutionCandidateDiscoverySnapshot,
  type ValidatedExecutionCandidateSnapshot,
} from './model'
import { requireCondition, requireValue, type ExecutionCandidateDiscoveryError } from './failure'
import { Pipeable } from '../pipeable'

export const validateIdentity = (
  input: ExecutionCandidateDiscoveryIdentity,
): Result.Result<ExecutionCandidateDiscoveryIdentity, ExecutionCandidateDiscoveryError> =>
  pipe(
    Schema.decodeResult(RuntimeIdentitySchema, strictParseOptions)(input),
    Result.mapError(
      (cause): ExecutionCandidateDiscoveryError => ({ _tag: 'IdentityDecodeFailed', failure: 'invalid-input', cause }),
    ),
    Result.flatMap((identity) =>
      pipe(
        makeStrategyProtocolHashResult(identity.strategy),
        Result.mapError(
          (cause): ExecutionCandidateDiscoveryError => ({
            _tag: 'IdentityDecodeFailed',
            failure: 'invalid-input',
            cause,
          }),
        ),
        Result.flatMap((expectedStrategyProtocolHash) =>
          requireCondition(identity.strategyProtocolHash === expectedStrategyProtocolHash, {
            _tag: 'StrategyProtocolMismatch',
            failure: 'invalid-input',
            observedStrategyProtocolHash: identity.strategyProtocolHash,
            expectedStrategyProtocolHash,
          }),
        ),
        Result.map(() => identity),
      ),
    ),
  )

export const selectCompletedCycle = (
  projection: CycleOperationsProjection,
): Result.Result<NonNullable<CycleOperationsProjection['last']>, ExecutionCandidateDiscoveryError> =>
  pipe(
    requireCondition(projection.unfinishedCycleCount === 0 && projection.current === null, {
      _tag: 'CycleUnfinished',
      failure: 'cycle-unfinished',
      unfinishedCycleCount: projection.unfinishedCycleCount,
      currentCycleId: projection.current?.cycleId ?? null,
    }),
    Result.flatMap(() =>
      requireValue(projection.last, {
        _tag: 'CycleMissing',
        failure: 'cycle-missing',
        source: 'projection',
        cycleId: null,
      }),
    ),
  )

const validateCycleProjection = (
  identity: ExecutionCandidateDiscoveryIdentity,
  snapshot: ExecutionCandidateDiscoverySnapshot,
  last: NonNullable<CycleOperationsProjection['last']>,
  terminalAt: string,
): Result.Result<void, ExecutionCandidateDiscoveryError> => {
  const { cycle } = snapshot
  return pipe(
    Result.all([
      requireCondition(last.phase === CycleState.Completed, {
        _tag: 'CycleStateMismatch',
        failure: 'cycle-mismatch',
        source: 'projection',
        observedState: last.phase,
      }),
      requireCondition(cycle.state === CycleState.Completed, {
        _tag: 'CycleStateMismatch',
        failure: 'cycle-mismatch',
        source: 'cycle-store',
        observedState: cycle.state,
      }),
      requireCondition(last.cycleId === cycle.identity.cycleId, {
        _tag: 'CycleIdentityMismatch',
        failure: 'cycle-mismatch',
        expectedCycleId: last.cycleId,
        observedCycleId: cycle.identity.cycleId,
      }),
      requireCondition(last.accountId === identity.accountId && cycle.identity.accountId === identity.accountId, {
        _tag: 'CycleAccountMismatch',
        failure: 'cycle-mismatch',
        expectedAccountId: identity.accountId,
        projectedAccountId: last.accountId,
        storedAccountId: cycle.identity.accountId,
      }),
      requireCondition(cycle.identity.qualificationRunId === identity.qualificationRunId, {
        _tag: 'CycleQualificationMismatch',
        failure: 'cycle-mismatch',
        expectedQualificationRunId: identity.qualificationRunId,
        observedQualificationRunId: cycle.identity.qualificationRunId,
      }),
      requireCondition(cycle.identity.strategyProtocolHash === identity.strategyProtocolHash, {
        _tag: 'CycleStrategyMismatch',
        failure: 'cycle-mismatch',
        expectedStrategyProtocolHash: identity.strategyProtocolHash,
        observedStrategyProtocolHash: cycle.identity.strategyProtocolHash,
      }),
      requireCondition(
        last.signalSessionDate === cycleAuthoritySessionDate(cycle.identity) &&
          last.executionSessionDate === cycle.identity.executionSessionDate &&
          last.submissionOpenAt === cycle.window.submissionOpenAt &&
          last.submissionCutoffAt === cycle.window.submissionCutoffAt &&
          last.executionOpenAt === cycle.window.executionOpenAt &&
          last.executionCloseAt === cycle.window.executionCloseAt &&
          last.terminalAt === terminalAt,
        {
          _tag: 'CycleChronologyMismatch',
          failure: 'cycle-mismatch',
          cycleId: cycle.identity.cycleId,
          projected: {
            signalSessionDate: last.signalSessionDate,
            executionSessionDate: last.executionSessionDate,
            submissionOpenAt: last.submissionOpenAt,
            submissionCutoffAt: last.submissionCutoffAt,
            executionOpenAt: last.executionOpenAt,
            executionCloseAt: last.executionCloseAt,
            terminalAt: last.terminalAt,
          },
          stored: {
            signalSessionDate: cycleAuthoritySessionDate(cycle.identity),
            executionSessionDate: cycle.identity.executionSessionDate,
            submissionOpenAt: cycle.window.submissionOpenAt,
            submissionCutoffAt: cycle.window.submissionCutoffAt,
            executionOpenAt: cycle.window.executionOpenAt,
            executionCloseAt: cycle.window.executionCloseAt,
            terminalAt,
          },
        },
      ),
    ]),
    Result.map(() => undefined),
  )
}

const validateDocumentBinding = (
  identity: ExecutionCandidateDiscoveryIdentity,
  snapshot: ExecutionCandidateDiscoverySnapshot,
  last: NonNullable<CycleOperationsProjection['last']>,
  snapshotId: string,
  decisionHash: string,
  now: number,
): Result.Result<void, ExecutionCandidateDiscoveryError> => {
  const { cycle, document } = snapshot
  return pipe(
    Result.all([
      requireCondition(snapshotId === last.snapshotId && snapshotId === document.bindings.snapshotId, {
        _tag: 'SnapshotBindingMismatch',
        failure: 'document-mismatch',
        storedSnapshotId: snapshotId,
        projectedSnapshotId: last.snapshotId,
        documentSnapshotId: document.bindings.snapshotId,
      }),
      requireCondition(decisionHash === last.decisionHash && decisionHash === document.contentHash, {
        _tag: 'DecisionBindingMismatch',
        failure: 'document-mismatch',
        storedDecisionHash: decisionHash,
        projectedDecisionHash: last.decisionHash,
        documentContentHash: document.contentHash,
      }),
      requireCondition(
        document.bindings.cycleId === cycle.identity.cycleId &&
          document.bindings.accountId === identity.accountId &&
          document.bindings.strategyName === identity.strategy.name &&
          document.bindings.strategyProtocolHash === identity.strategyProtocolHash,
        {
          _tag: 'DocumentIdentityMismatch',
          failure: 'document-mismatch',
          expected: {
            cycleId: cycle.identity.cycleId,
            accountId: identity.accountId,
            strategyName: identity.strategy.name,
            strategyProtocolHash: identity.strategyProtocolHash,
          },
          observed: {
            cycleId: document.bindings.cycleId,
            accountId: document.bindings.accountId,
            strategyName: document.bindings.strategyName,
            strategyProtocolHash: document.bindings.strategyProtocolHash,
          },
        },
      ),
      requireCondition(document.bindings.policyHash === identity.policyHash, {
        _tag: 'DocumentPolicyMismatch',
        failure: 'document-mismatch',
        expectedPolicyHash: identity.policyHash,
        observedPolicyHash: document.bindings.policyHash,
      }),
      requireCondition(
        document.targetPlan.status === TargetPlanStatus.Planned && document.targetPlan.intentTargets.length > 0,
        {
          _tag: 'TargetPlanUnavailable',
          failure: 'document-mismatch',
          status: document.targetPlan.status,
          intentTargetCount: document.targetPlan.intentTargets.length,
        },
      ),
      requireCondition(document.deltaRisk.length === document.targetPlan.intentTargets.length, {
        _tag: 'RiskCountMismatch',
        failure: 'risk-mismatch',
        deltaRiskCount: document.deltaRisk.length,
        intentTargetCount: document.targetPlan.intentTargets.length,
      }),
      requireCondition(
        document.submissionCutoffAt === cycle.window.submissionCutoffAt &&
          document.expiresAt === cycle.window.submissionCutoffAt,
        {
          _tag: 'DocumentCutoffMismatch',
          failure: 'document-mismatch',
          cycleSubmissionCutoffAt: cycle.window.submissionCutoffAt,
          documentSubmissionCutoffAt: document.submissionCutoffAt,
          documentExpiresAt: document.expiresAt,
        },
      ),
      requireCondition(now < Date.parse(document.expiresAt), {
        _tag: 'DocumentStale',
        failure: 'document-stale',
        observedAtMs: now,
        expiresAt: document.expiresAt,
      }),
    ]),
    Result.map(() => undefined),
  )
}

const validateAuthority = (
  identity: ExecutionCandidateDiscoveryIdentity,
  projection: CycleOperationsProjection,
): Result.Result<void, ExecutionCandidateDiscoveryError> => {
  const authority = projection.authority
  return requireCondition(
    authority !== null &&
      authority.generationHash === identity.authorityGenerationHash &&
      authority.maximum === Authority.Observe &&
      authority.effective === Authority.Observe,
    {
      _tag: 'AuthorityMismatch',
      failure: 'authority-mismatch',
      expectedGenerationHash: identity.authorityGenerationHash,
      observedGenerationHash: authority?.generationHash ?? null,
      observedMaximum: authority?.maximum ?? null,
      observedEffective: authority?.effective ?? null,
    },
  )
}

const validateRisk = (document: ObserveShadowDecisionDocument): Result.Result<void, ExecutionCandidateDiscoveryError> =>
  pipe(
    document.deltaRisk.map((risk, index) => {
      const failed = risk.evaluation.gates.filter((gate) => !gate.passed)
      return requireCondition(
        risk.evaluation.decision.outcome === RiskOutcome.Blocked &&
          risk.evaluation.decision.reasonCodes.length === 1 &&
          isAuthorityNotGrantedReason(risk.evaluation.decision.reasonCodes[0] ?? '') &&
          failed.length === 1 &&
          failed[0]?.name === Gate.Authority &&
          isAuthorityNotGrantedReason(failed[0]?.reason ?? ''),
        {
          _tag: 'RiskAuthorityMismatch',
          failure: 'risk-mismatch',
          index,
          outcome: risk.evaluation.decision.outcome,
          reasonCodes: risk.evaluation.decision.reasonCodes,
          failedGates: failed.map(({ name, reason }) => ({ name, reason })),
        },
      )
    }),
    Result.all,
    Result.map(() => undefined),
  )

const validateReconciliation = (
  identity: ExecutionCandidateDiscoveryIdentity,
  snapshot: ExecutionCandidateDiscoverySnapshot,
  reconciliation: NonNullable<CycleOperationsProjection['reconciliation']>,
): Result.Result<void, ExecutionCandidateDiscoveryError> =>
  pipe(
    Result.all([
      requireCondition(
        reconciliation.accountId === identity.accountId &&
          reconciliation.reconciliationId === snapshot.document.bindings.reconciliationId &&
          reconciliation.status === 'EXACT' &&
          reconciliation.discrepancyCount === 0 &&
          reconciliation.coversLatestMutation,
        {
          _tag: 'ReconciliationMismatch',
          failure: 'document-mismatch',
          expectedAccountId: identity.accountId,
          observedAccountId: reconciliation.accountId,
          expectedReconciliationId: snapshot.document.bindings.reconciliationId,
          observedReconciliationId: reconciliation.reconciliationId,
          status: reconciliation.status,
          discrepancyCount: reconciliation.discrepancyCount,
          coversLatestMutation: reconciliation.coversLatestMutation,
        },
      ),
      requireCondition(snapshot.projection.mutations.unresolvedCount === 0, {
        _tag: 'UnresolvedMutations',
        failure: 'document-mismatch',
        unresolvedMutationCount: snapshot.projection.mutations.unresolvedCount,
        reconciliationId: reconciliation.reconciliationId,
      }),
    ]),
    Result.map(() => undefined),
  )

const assembleBinding = (
  identity: ExecutionCandidateDiscoveryIdentity,
  snapshot: ExecutionCandidateDiscoverySnapshot,
  terminalAt: string,
  snapshotId: string,
): ExecutionCandidateDiscoveryBinding => ({
  schemaVersion: bindingSchemaVersion,
  runtime: identity,
  cycle: {
    cycleId: snapshot.cycle.identity.cycleId,
    signalSessionDate: cycleAuthoritySessionDate(snapshot.cycle.identity),
    executionSessionDate: snapshot.cycle.identity.executionSessionDate,
    snapshotId,
    decisionHash: snapshot.document.contentHash,
    submissionCutoffAt: snapshot.cycle.window.submissionCutoffAt,
    terminalAt,
  },
  document: {
    contentHash: snapshot.document.contentHash,
    snapshotContentHash: snapshot.document.bindings.snapshotContentHash,
    snapshotFinalizedAt: snapshot.document.bindings.snapshotFinalizedAt,
    strategyDecisionHash: snapshot.document.bindings.strategyDecisionHash,
    policyHash: snapshot.document.bindings.policyHash,
    planningBrokerStateHash: snapshot.document.bindings.planningBrokerStateHash,
    reconciliationId: snapshot.document.bindings.reconciliationId,
    reconciliationHash: snapshot.document.bindings.reconciliationHash,
    targetPlanInputHash: snapshot.document.targetPlan.inputHash,
    targetPlanOutputHash: snapshot.document.targetPlan.outputHash,
    createdAt: snapshot.document.createdAt,
    expiresAt: snapshot.document.expiresAt,
  },
})

const validateSnapshotForIdentityDataFirst = (
  identity: ExecutionCandidateDiscoveryIdentity,
  snapshot: ExecutionCandidateDiscoverySnapshot,
  now: number,
): Result.Result<ValidatedExecutionCandidateSnapshot, ExecutionCandidateDiscoveryError> =>
  pipe(
    Result.Do,
    Result.bind('last', () =>
      requireValue(snapshot.projection.last, {
        _tag: 'CycleMissing',
        failure: 'cycle-missing',
        source: 'projection',
        cycleId: null,
      }),
    ),
    Result.bind('terminalAt', () =>
      requireValue(snapshot.cycle.terminalAt, {
        _tag: 'CycleTerminalAtMissing',
        failure: 'cycle-mismatch',
        cycleId: snapshot.cycle.identity.cycleId,
      }),
    ),
    Result.bind('snapshotId', () =>
      requireValue(snapshot.cycle.bindings.snapshotId, {
        _tag: 'CycleBindingMissing',
        failure: 'document-mismatch',
        binding: 'snapshot',
        cycleId: snapshot.cycle.identity.cycleId,
      }),
    ),
    Result.bind('decisionHash', () =>
      requireValue(snapshot.cycle.bindings.decisionHash, {
        _tag: 'CycleBindingMissing',
        failure: 'document-mismatch',
        binding: 'decision',
        cycleId: snapshot.cycle.identity.cycleId,
      }),
    ),
    Result.bind('reconciliation', () =>
      requireValue(snapshot.projection.reconciliation, {
        _tag: 'ReconciliationMissing',
        failure: 'document-mismatch',
        accountId: identity.accountId,
      }),
    ),
    Result.flatMap(({ decisionHash, last, reconciliation, snapshotId, terminalAt }) =>
      pipe(
        Result.all([
          validateCycleProjection(identity, snapshot, last, terminalAt),
          validateDocumentBinding(identity, snapshot, last, snapshotId, decisionHash, now),
          validateAuthority(identity, snapshot.projection),
          validateRisk(snapshot.document),
          validateReconciliation(identity, snapshot, reconciliation),
        ]),
        Result.map(() => ({
          [ValidatedSnapshotTypeId]: true as const,
          identity,
          snapshot,
          binding: assembleBinding(identity, snapshot, terminalAt, snapshotId),
        })),
      ),
    ),
  )

export const validateSnapshotForIdentity = Pipeable.dual(3, validateSnapshotForIdentityDataFirst)

const validateExecutionCandidateDiscoverySnapshotDataFirst = (
  identity: ExecutionCandidateDiscoveryIdentity,
  snapshot: ExecutionCandidateDiscoverySnapshot,
  now: number,
): Result.Result<ValidatedExecutionCandidateSnapshot, ExecutionCandidateDiscoveryError> =>
  pipe(
    validateIdentity(identity),
    Result.flatMap((validatedIdentity) => validateSnapshotForIdentity(validatedIdentity, snapshot, now)),
  )

export const validateExecutionCandidateDiscoverySnapshot = Pipeable.dual(
  3,
  validateExecutionCandidateDiscoverySnapshotDataFirst,
)
