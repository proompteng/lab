import { Effect, Option, Result } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import { CycleState, CycleTerminalReason, type AutonomousCycle } from '../cycle'
import { CycleRunnerError } from '../cycle-runner'
import { IntentStore, planPaperIntent, type StoredIntent } from '../execution/intents'
import {
  Authority,
  IntentState,
  KillState,
  OrderSide,
  TerminalOutcome,
  type AuthorityState,
  type Intent,
} from '../execution/contracts'
import { MutationStore, type MutationEvent } from '../execution/mutations'
import { makeFillTerms, MICROS } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import type { ReconciliationPassResult } from '../reconciler'
import type { Policy } from '../risk'
import type { PaperDecisionDocument } from '../shadow-decision-contract'
import { TargetPlanStatus } from '../target-planner'
import type { CausalProtocol } from '../protocol'
import {
  decidePaperCycleCompletion,
  countOpenPositions,
  decidePreparedCloseIntentAdmission,
  decidePreparedMutationIntent,
  decidePreparedMutationIntentAdmission,
  decidePreparedMutationRecovery,
  expiredPaperPlanTerminalReason,
  mutationRecoveryIsDue,
  paperCycleHasFilledIntent,
  paperSubmitExpiresAt,
  type PaperCycleIntentTerminalEvidence,
  type PreparedMutationCycleStep,
} from './mutation-decisions'
import { mutationRunnerError } from './mutation-interpreter'

export type MutationPreparationFacts = {
  readonly snapshot: {
    readonly contentHash: string
    readonly finalizedAt: string
  }
  readonly reconciliation: ReconciliationPassResult
  readonly authority: AuthorityState
  readonly evaluatedAt: string
}

export type MutationIntentInput = {
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly mutationPhase?: 'ENTRY' | 'CLOSE'
  readonly paperEpisodeCutoffAt?: string
  readonly paperEpisodeExpiresAt?: string
}

export type MutationPreparation = {
  readonly executionModel: CausalProtocol['executionModel']
}

export type MutationPreparationFactsRequest<
  R,
  E,
  I extends MutationIntentInput = MutationIntentInput,
  P extends MutationPreparation = MutationPreparation,
> = {
  readonly input: I
  readonly preparation: P
  readonly policy: Policy
  readonly cycle: AutonomousCycle
  readonly document: PaperDecisionDocument
  readonly reconcile: Effect.Effect<ReconciliationPassResult, E, R>
}

export type MutationPreparationDependencies<
  R,
  E,
  I extends MutationIntentInput = MutationIntentInput,
  P extends MutationPreparation = MutationPreparation,
> = {
  readonly now: Effect.Effect<string, never, R>
  readonly readFacts: (
    request: MutationPreparationFactsRequest<R, E, I, P>,
  ) => Effect.Effect<MutationPreparationFacts, CycleRunnerError, R>
  readonly restrictAuthority: (subject: string, reason: string) => Effect.Effect<void, CycleRunnerError, R>
}

const validateBoundMutationDocument = (
  input: MutationIntentInput,
  cycle: AutonomousCycle,
  document: PaperDecisionDocument,
): Result.Result<void, CycleRunnerError> =>
  cycle.state !== CycleState.Active ||
  (input.mutationPhase === 'CLOSE'
    ? cycle.bindings.decisionHash === undefined
    : cycle.bindings.decisionHash !== document.contentHash) ||
  cycle.bindings.snapshotId !== document.bindings.snapshotId ||
  cycle.identity.cycleId !== document.bindings.cycleId ||
  cycle.identity.qualificationRunId !== document.bindings.qualificationRunId ||
  cycle.identity.accountId !== document.bindings.accountId ||
  cycle.identity.strategyProtocolHash !== document.bindings.strategyProtocolHash ||
  (input.mutationPhase === 'CLOSE' && input.authorityGenerationHash !== document.bindings.authorityGenerationHash) ||
  input.accountId !== document.bindings.accountId
    ? Result.fail(
        mutationRunnerError(
          'durable shadow plan does not match the mutation cycle account, protocol, and decision binding',
          undefined,
          'contract',
        ),
      )
    : Result.succeed(undefined)

const validateCurrentMutationPolicy = (
  policy: Policy,
  document: PaperDecisionDocument,
): Result.Result<void, CycleRunnerError> => {
  const policyHash = canonicalHashV1Result(policy)
  if (Result.isFailure(policyHash)) {
    return Result.fail(mutationRunnerError('mutation cycle risk policy is not canonicalizable', policyHash.failure))
  }
  return policyHash.success !== document.bindings.policyHash
    ? Result.fail(
        mutationRunnerError(
          'current source-controlled PAPER risk policy changed from the durable decision binding',
          undefined,
          'contract',
        ),
      )
    : Result.succeed(undefined)
}

const boundPaperSubmissionCutoff = (
  input: MutationIntentInput,
  cycle: AutonomousCycle,
  document: PaperDecisionDocument,
): Result.Result<string, CycleRunnerError> => {
  if (input.mutationPhase === 'CLOSE') {
    if (
      input.paperEpisodeExpiresAt === undefined ||
      document.submissionCutoffAt !== input.paperEpisodeExpiresAt ||
      document.expiresAt !== input.paperEpisodeExpiresAt
    ) {
      return Result.fail(
        mutationRunnerError(
          'durable PAPER close plan changed from its immutable activation close lease',
          undefined,
          'contract',
        ),
      )
    }
    return Result.succeed(input.paperEpisodeExpiresAt)
  }
  if (
    document.submissionCutoffAt !== cycle.window.submissionCutoffAt ||
    document.expiresAt !== cycle.window.submissionCutoffAt
  ) {
    return Result.fail(
      mutationRunnerError(
        'durable PAPER decision changed from its immutable cycle submission window',
        undefined,
        'contract',
      ),
    )
  }
  return Result.succeed(cycle.window.submissionCutoffAt)
}

const immutableIntentBindingMatches = (stored: Intent, expected: Intent): boolean =>
  stored.schemaVersion === expected.schemaVersion &&
  stored.intentId === expected.intentId &&
  stored.authorityGenerationHash === expected.authorityGenerationHash &&
  stored.strategyName === expected.strategyName &&
  stored.cycleId === expected.cycleId &&
  stored.decisionHash === expected.decisionHash &&
  stored.policyHash === expected.policyHash &&
  stored.accountId === expected.accountId &&
  stored.clientOrderId === expected.clientOrderId &&
  stored.symbol === expected.symbol &&
  stored.side === expected.side &&
  stored.orderType === expected.orderType &&
  stored.timeInForce === expected.timeInForce &&
  stored.quantityMicros === expected.quantityMicros &&
  stored.notionalLimitMicros === expected.notionalLimitMicros &&
  stored.createdAt === expected.createdAt

const validateCurrentMutationExecutionTerms = (
  preparation: MutationPreparation,
  targetIntent: PaperDecisionDocument['targetPlan']['intentTargets'][number],
  target: PaperDecisionDocument['targetPlan']['targets'][number],
  riskBinding: PaperDecisionDocument['deltaRisk'][number],
): Result.Result<void, CycleRunnerError> => {
  const fillTerms = makeFillTerms(
    targetIntent.side === OrderSide.Buy ? 'buy' : 'sell',
    BigInt(targetIntent.quantityMicros),
    BigInt(target.referencePriceMicros),
    preparation.executionModel,
    MICROS,
  )
  if (Result.isFailure(fillTerms)) {
    return Result.fail(mutationRunnerError('mutation execution terms are invalid', fillTerms.failure, 'contract'))
  }
  return fillTerms.success.notionalMicros.toString() === riskBinding.notionalLimitMicros
    ? Result.succeed(undefined)
    : Result.fail(
        mutationRunnerError(
          'durable mutation notional changed from the current execution model',
          undefined,
          'contract',
        ),
      )
}

type PreparedPaperIntent = {
  readonly intent: Intent
  readonly targetIntent: PaperDecisionDocument['targetPlan']['intentTargets'][number]
  readonly target: PaperDecisionDocument['targetPlan']['targets'][number]
  readonly riskBinding: PaperDecisionDocument['deltaRisk'][number]
  readonly stored: StoredIntent | undefined
  readonly latestSubmit: MutationEvent | undefined
  readonly latestCancel: MutationEvent | undefined
}

type PaperIntentRecoveryLookup = Omit<PreparedPaperIntent, 'intent'> & {
  readonly intentId: string
}

export const prepareMutationIntent = <R, E, I extends MutationIntentInput, P extends MutationPreparation>(
  input: I,
  preparation: P,
  policy: Policy,
  cycle: AutonomousCycle,
  document: PaperDecisionDocument,
  reconcile: Effect.Effect<ReconciliationPassResult, E, R>,
  allowSubmit: boolean,
  dependencies: MutationPreparationDependencies<R, E, I, P>,
): Effect.Effect<PreparedMutationCycleStep, CycleRunnerError, R | IntentStore | MutationStore> =>
  Effect.gen(function* () {
    yield* Effect.fromResult(validateBoundMutationDocument(input, cycle, document))
    const submissionCutoffAt = yield* Effect.fromResult(boundPaperSubmissionCutoff(input, cycle, document))
    const generationIsSuperseded = input.authorityGenerationHash !== document.bindings.authorityGenerationHash
    if (document.riskBlock !== undefined) {
      return {
        _tag: 'Block',
        reason: CycleTerminalReason.Risk,
        observedAt: yield* dependencies.now,
      }
    }
    if (document.targetPlan.status !== TargetPlanStatus.Planned) return { _tag: 'RunCycle' }

    const intentStore = yield* IntentStore
    const mutationStore = yield* MutationStore
    const targets = new Map(document.targetPlan.targets.map((target) => [target.symbol, target]))
    const documentAuthority: AuthorityState = {
      schemaVersion: 'bayn.paper-authority.v1',
      generationHash: document.bindings.authorityGenerationHash,
      maximum: Authority.Paper,
      effective: Authority.Paper,
      kill: KillState.Clear,
      version: 1,
      updatedAt: document.createdAt,
    }
    const recoveryLookups: PaperIntentRecoveryLookup[] = []

    for (const [index, targetIntent] of document.targetPlan.intentTargets.entries()) {
      const riskBinding = document.deltaRisk[index]
      const target = targets.get(targetIntent.symbol)
      const intentId = document.orderedIntentIds[index]
      if (riskBinding === undefined || target === undefined || intentId === undefined) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable mutation target is missing its intent, risk, or final-position binding',
            undefined,
            'contract',
          ),
        )
      }
      const stored = yield* intentStore
        .read(intentId)
        .pipe(
          Effect.mapError((cause) => mutationRunnerError('durable PAPER intent recovery read failed', cause, 'store')),
        )
      const existing = Option.getOrUndefined(stored)
      const latestSubmit = yield* mutationStore
        .latest(intentId, MutationOperation.Submit)
        .pipe(Effect.mapError((cause) => mutationRunnerError('durable submit state read failed', cause, 'store')))
      const latestCancel = yield* mutationStore
        .latest(intentId, MutationOperation.Cancel)
        .pipe(Effect.mapError((cause) => mutationRunnerError('durable cancel state read failed', cause, 'store')))
      if (existing === undefined && (latestSubmit !== undefined || latestCancel !== undefined)) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable mutation exists without its authority-bound intent',
            { latestSubmit, latestCancel },
            'contract',
          ),
        )
      }
      if (existing !== undefined && existing.intent.intentId !== intentId) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable PAPER intent recovery returned a different intent identity',
            undefined,
            'contract',
          ),
        )
      }
      recoveryLookups.push({
        intentId,
        targetIntent,
        target,
        riskBinding,
        stored: existing,
        latestSubmit,
        latestCancel,
      })
    }

    const preparedIntents: PreparedPaperIntent[] = []
    for (const lookup of recoveryLookups) {
      const intent = yield* planPaperIntent(
        {
          schemaVersion: 'bayn.paper-intent-plan.v1',
          ...lookup.targetIntent,
          notionalLimitMicros: lookup.riskBinding.notionalLimitMicros,
          ...(document.replanGenerationHash === undefined
            ? {}
            : { replanGenerationHash: document.replanGenerationHash }),
          createdAt: document.createdAt,
        },
        { authority: documentAuthority },
      ).pipe(
        Effect.mapError((cause) =>
          mutationRunnerError('durable PAPER intent reconstruction failed', cause, 'contract'),
        ),
      )
      if (lookup.intentId !== intent.intentId) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable PAPER intent identity or order changed after decision binding',
            undefined,
            'contract',
          ),
        )
      }
      if (lookup.stored !== undefined && !immutableIntentBindingMatches(lookup.stored.intent, intent)) {
        return yield* Effect.fail(
          mutationRunnerError('stored PAPER intent changed from its durable decision binding', undefined, 'contract'),
        )
      }
      preparedIntents.push({ ...lookup, intent })
    }

    const recoveryObservedAt = yield* dependencies.now
    for (const prepared of preparedIntents) {
      const existing = prepared.stored
      if (existing === undefined) continue
      const recovery = yield* Effect.fromResult(
        decidePreparedMutationRecovery(existing.intent, prepared.latestSubmit, prepared.latestCancel),
      ).pipe(Effect.mapError((cause) => mutationRunnerError(cause.message, cause, 'contract')))
      if (recovery._tag === 'Recover') {
        return mutationRecoveryIsDue(recovery.event, recoveryObservedAt)
          ? {
              _tag: 'Execute',
              action:
                recovery.operation === MutationOperation.Submit
                  ? ('RECOVER_SUBMIT' as const)
                  : ('RECOVER_CANCEL' as const),
              intentId: prepared.intent.intentId,
              observedAt: recoveryObservedAt,
            }
          : { _tag: 'Wait', observedAt: recoveryObservedAt }
      }
    }

    if (generationIsSuperseded) {
      return {
        _tag: 'Block',
        reason: CycleTerminalReason.ProvenanceMismatch,
        observedAt: recoveryObservedAt,
      }
    }

    yield* Effect.fromResult(validateCurrentMutationPolicy(policy, document))

    const uncommittedIntents = preparedIntents.filter((prepared) => prepared.stored === undefined)
    if (!allowSubmit && uncommittedIntents.length > 0) {
      return { _tag: 'Wait', observedAt: recoveryObservedAt }
    }
    if (allowSubmit) {
      for (const prepared of preparedIntents) {
        const requiresFreshSubmission =
          prepared.stored === undefined ||
          (prepared.stored.intent.state !== IntentState.Terminal && prepared.latestSubmit === undefined)
        if (!requiresFreshSubmission) continue
        yield* Effect.fromResult(
          validateCurrentMutationExecutionTerms(
            preparation,
            prepared.targetIntent,
            prepared.target,
            prepared.riskBinding,
          ),
        )
      }
    }
    if (uncommittedIntents.length > 0) {
      const commitObservedAt = yield* dependencies.now
      const commitExpiresAt = uncommittedIntents.reduce(
        (expiresAt, prepared) => paperSubmitExpiresAt(expiresAt, prepared.riskBinding.evaluation.decision.expiresAt),
        document.expiresAt,
      )
      const expirationReason = expiredPaperPlanTerminalReason(commitObservedAt, commitExpiresAt, submissionCutoffAt)
      if (expirationReason !== undefined) {
        return {
          _tag: 'Block',
          reason: expirationReason,
          observedAt: commitObservedAt,
        }
      }
      if (
        preparedIntents.some((prepared) => prepared.latestSubmit !== undefined || prepared.latestCancel !== undefined)
      ) {
        return yield* Effect.fail(
          mutationRunnerError(
            'broker mutation evidence exists before the complete immutable intent set was committed',
            undefined,
            'contract',
          ),
        )
      }
    }

    if (input.mutationPhase === 'CLOSE' && intentStore.commitClosing === undefined) {
      return yield* Effect.fail(
        mutationRunnerError(
          'PAPER close intent store does not expose the close-only authority port',
          undefined,
          'store',
        ),
      )
    }
    yield* Effect.forEach(
      preparedIntents,
      (prepared) =>
        (input.mutationPhase === 'CLOSE' && intentStore.commitClosing !== undefined
          ? intentStore.commitClosing(prepared.intent, prepared.riskBinding.evaluation.decision)
          : intentStore.commit(prepared.intent, prepared.riskBinding.evaluation.decision)
        ).pipe(
          Effect.mapError((cause) => mutationRunnerError('durable PAPER intent-set commit failed', cause, 'store')),
        ),
      { concurrency: 1, discard: true },
    )

    const facts = yield* dependencies.readFacts({ input, preparation, policy, cycle, document, reconcile })
    if (
      document.bindings.snapshotContentHash !== facts.snapshot.contentHash ||
      document.bindings.snapshotFinalizedAt !== facts.snapshot.finalizedAt
    ) {
      return yield* Effect.fail(
        mutationRunnerError('bound mutation cycle snapshot publication changed after planning', undefined, 'contract'),
      )
    }

    const terminalEvidence: PaperCycleIntentTerminalEvidence[] = []
    const hasFilledIntent = paperCycleHasFilledIntent(
      preparedIntents.flatMap((prepared) => (prepared.stored === undefined ? [] : [prepared.stored.intent])),
      facts.reconciliation.brokerState.orders,
    )
    const hasOpenPosition = countOpenPositions(facts.reconciliation.brokerState.positions) > 0
    for (const prepared of preparedIntents) {
      const stored = yield* intentStore
        .read(prepared.intent.intentId)
        .pipe(Effect.mapError((cause) => mutationRunnerError('committed PAPER intent readback failed', cause, 'store')))
      const record = Option.getOrUndefined(stored)
      if (record === undefined) {
        return yield* Effect.fail(
          mutationRunnerError('committed PAPER intent disappeared before execution selection', undefined, 'contract'),
        )
      }
      const latest = yield* mutationStore
        .latest(prepared.intent.intentId, MutationOperation.Submit)
        .pipe(Effect.mapError((cause) => mutationRunnerError('durable submit state refresh failed', cause, 'store')))
      const decision = yield* Effect.fromResult(decidePreparedMutationIntent(record.intent, latest)).pipe(
        Effect.mapError((cause) => mutationRunnerError(cause.message, cause, 'contract')),
      )
      switch (decision._tag) {
        case 'SkipTerminal':
          terminalEvidence.push({
            state: record.intent.state,
            terminalOutcome: record.intent.terminalOutcome,
            updatedAt: record.updatedAt,
            ...(latest === undefined ? {} : { latestMutationAt: latest.occurredAt }),
          })
          if (record.intent.terminalOutcome !== TerminalOutcome.Filled) {
            yield* dependencies.restrictAuthority(
              `bound PAPER cycle ${cycle.identity.cycleId}`,
              `intent ${prepared.intent.intentId} ended ${record.intent.terminalOutcome ?? 'without outcome'}`,
            )
            const recoveryDeadline =
              input.mutationPhase === 'CLOSE' ? input.paperEpisodeExpiresAt : input.paperEpisodeCutoffAt
            if (
              (hasFilledIntent || (input.mutationPhase === 'CLOSE' && hasOpenPosition)) &&
              recoveryDeadline !== undefined &&
              facts.evaluatedAt < recoveryDeadline
            ) {
              return { _tag: 'Wait', observedAt: facts.evaluatedAt }
            }
            return {
              _tag: 'Block',
              reason: CycleTerminalReason.Risk,
              observedAt: facts.evaluatedAt,
            }
          }
          break
        case 'Pending':
          return latest !== undefined && mutationRecoveryIsDue(latest, facts.evaluatedAt)
            ? {
                _tag: 'Execute',
                action: 'RECOVER_SUBMIT',
                intentId: prepared.intent.intentId,
                observedAt: facts.evaluatedAt,
              }
            : { _tag: 'Wait', observedAt: facts.evaluatedAt }
        case 'Recover':
          return latest !== undefined && mutationRecoveryIsDue(latest, facts.evaluatedAt)
            ? {
                _tag: 'Execute',
                action: 'RECOVER_SUBMIT',
                intentId: prepared.intent.intentId,
                observedAt: facts.evaluatedAt,
              }
            : { _tag: 'Wait', observedAt: facts.evaluatedAt }
        case 'Submit': {
          if (!allowSubmit) return { _tag: 'Wait', observedAt: facts.evaluatedAt }
          const submitExpiresAt = paperSubmitExpiresAt(
            submissionCutoffAt,
            prepared.riskBinding.evaluation.decision.expiresAt,
          )
          const expirationReason = expiredPaperPlanTerminalReason(
            facts.evaluatedAt,
            submitExpiresAt,
            submissionCutoffAt,
          )
          if (expirationReason !== undefined) {
            return {
              _tag: 'Block',
              reason: expirationReason,
              observedAt: facts.evaluatedAt,
            }
          }
          yield* Effect.fromResult(
            input.mutationPhase === 'CLOSE'
              ? decidePreparedCloseIntentAdmission(
                  prepared.intent,
                  decision,
                  facts.evaluatedAt,
                  submitExpiresAt,
                  facts.reconciliation.riskContext.unknownMutationCount,
                  facts.reconciliation.brokerState.reconciliation.status,
                  facts.reconciliation.report.metrics.accountingExact,
                  facts.reconciliation.brokerState.unknownOrderCount,
                )
              : decidePreparedMutationIntentAdmission(
                  decision,
                  facts.authority.effective,
                  facts.evaluatedAt,
                  submitExpiresAt,
                  facts.reconciliation.riskContext.unknownMutationCount,
                  facts.reconciliation.brokerState.reconciliation.status,
                  facts.reconciliation.report.metrics.accountingExact,
                  facts.reconciliation.brokerState.unknownOrderCount,
                ),
          ).pipe(Effect.mapError((cause) => mutationRunnerError(cause.message, cause, 'contract')))
          return {
            _tag: 'Execute',
            action: 'SUBMIT',
            intentId: prepared.intent.intentId,
            observedAt: facts.evaluatedAt,
            submitExpiresAt,
          }
        }
      }
    }

    const completion = decidePaperCycleCompletion(document.createdAt, terminalEvidence, {
      status: facts.reconciliation.brokerState.reconciliation.status,
      reconciledAt: facts.reconciliation.brokerState.reconciliation.reconciledAt,
      accountingExact: facts.reconciliation.report.metrics.accountingExact,
      unknownMutationCount: facts.reconciliation.riskContext.unknownMutationCount,
      unknownOrderCount: facts.reconciliation.brokerState.unknownOrderCount,
      openPositionCount: countOpenPositions(facts.reconciliation.brokerState.positions),
    })
    return completion._tag === 'Complete'
      ? { _tag: 'Complete', observedAt: facts.evaluatedAt }
      : { _tag: 'Wait', observedAt: facts.evaluatedAt }
  })
