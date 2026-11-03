import { Clock, Effect } from 'effect'

import {
  EntryInferenceError,
  EntryInferenceJournal,
  prepareClaimedEntry,
  type EntryInferenceClaim,
  type EntryStageTransition,
} from './entry-inference'
import { JevEvaluationStore, makeJevDispatch, type JevDispatch, type JevEvaluationRecord } from './evaluation'
import { evaluateClaimedEntryInferences } from './entry-inference-batch'
import { entryInferenceAvailableAt, JevEvidenceError, JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { JevResolutionStatus } from './resolution'
import type { StagedDispatchClaim } from './staged-checkpoint'

export const persistEvaluationFixture = (
  store: typeof JevEvaluationStore.Service,
  request: JevEvaluationRecord['request'],
  receipt: JevEvaluationRecord['receipt'],
) =>
  store.recordAll([{ request, receipt }]).pipe(
    Effect.map((records) => {
      const resolution = records.get(request.requestId)
      if (resolution === undefined) throw new Error('Fixture receipt has no persisted resolution')
      return resolution
    }),
  )

const onlyAdmission = <A>(values: readonly A[]) => {
  const [value] = values
  if (values.length !== 1 || value === undefined) throw new Error('Fixture expects one stage admission')
  return value
}

export const persistVisualClaimFixture = (journal: typeof EntryInferenceJournal.Service, claim: StagedDispatchClaim) =>
  journal
    .recordVisualClaims([claim])
    .pipe(Effect.map((values) => ({ dispatchAllowed: onlyAdmission(values).dispatchAllowed })))

export const persistVisualTransitionFixture = (
  journal: typeof EntryInferenceJournal.Service,
  transition: EntryStageTransition,
) =>
  journal
    .recordTransitions([transition])
    .pipe(Effect.map((values) => ({ dispatchAllowed: onlyAdmission(values).dispatchAllowed })))

export const persistHandoffFixture = (
  journal: typeof EntryInferenceJournal.Service,
  handoff: Extract<EntryStageTransition, { readonly terminal: null }>['successor']['handoff'],
) =>
  journal
    .recordTransitions([{ terminal: null, successor: { kind: 'HANDOFF', handoff } }])
    .pipe(Effect.map((values) => ({ dispatchAllowed: onlyAdmission(values).dispatchAllowed })))

export const evaluateFixtureEntry = (claim: EntryInferenceClaim) =>
  Effect.gen(function* () {
    const prepared = yield* Effect.fromResult(prepareClaimedEntry(claim)).pipe(
      Effect.mapError((cause) =>
        cause instanceof EntryInferenceError
          ? cause
          : new EntryInferenceError({ category: 'INPUT', message: 'Fixture input is malformed', cause }),
      ),
    )
    const request: JevEvaluationRecord['request'] = {
      schemaVersion: 'bayn.jev-evaluation-request.v3',
      requestId: claim.requestId,
      cycleId: 'a'.repeat(64),
      authorityGenerationHash: 'b'.repeat(64),
      snapshotId: 'c'.repeat(64),
      symbol: claim.input.chartSource.symbol,
      observedAt: claim.observedAt,
      expiresAt: claim.expiresAt,
      request: prepared.prepared.input,
      requestHash: prepared.prepared.requestHash,
    }
    if (prepared.visualClaim !== null) {
      const admitted = yield* persistVisualClaimFixture(yield* EntryInferenceJournal, prepared.visualClaim)
      if (!admitted.dispatchAllowed)
        return yield* new EntryInferenceError({
          category: 'EXISTING_HANDOFF',
          message: 'Fixture claim already admitted',
        })
    }
    const completed = yield* evaluateClaimedEntryInferences([
      makeJevDispatch({ request, claimedAt: claim.claimedAt, visualClaim: prepared.visualClaim }),
    ]).pipe(
      Effect.provideService(JevEvaluationStore, {
        read: () => Effect.die('Unexpected fixture read'),
        abandon: () => Effect.die('Unexpected fixture abandon'),
        recordAll: () => Effect.die('A single chart fixture cannot lose a completed sibling'),
      }),
    )
    return onlyAdmission(completed)
  })

export const evaluateAdmittedFixture = (dispatch: JevDispatch) =>
  Effect.gen(function* () {
    const [completion] = yield* evaluateClaimedEntryInferences([dispatch])
    if (completion === undefined) return yield* new JevEvidenceError({ message: 'Fixture has no completion' })
    const request = dispatch.request
    const receipt = yield* Effect.fromResult(
      makeJevEvaluationReceipt(request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: request.requestId,
        startedAt: dispatch.claimedAt,
        completedAt: completion.completedAt,
        outcome: { status: JevOutcome.Completed, completion },
      }),
    )
    const resolution = yield* persistEvaluationFixture(yield* JevEvaluationStore, request, receipt)
    if (resolution.status !== JevResolutionStatus.Recorded)
      return yield* new JevEvidenceError({ message: 'Fixture receipt was abandoned' })
    const inference = yield* Effect.fromResult(
      entryInferenceAvailableAt(request, receipt, yield* Clock.currentTimeMillis, request.request.schemaVersion),
    )
    return { request, receipt, resolution, inference }
  })

export const admitAndEvaluateFixture = (input: Pick<JevDispatch, 'request' | 'claimedAt'>) =>
  Effect.gen(function* () {
    const { request, claimedAt } = input
    const prepared = yield* Effect.fromResult(
      prepareClaimedEntry({
        requestId: request.requestId,
        input: request.request,
        observedAt: request.observedAt,
        expiresAt: request.expiresAt,
        claimedAt,
      }),
    )
    if (prepared.visualClaim !== null) {
      const admitted = yield* persistVisualClaimFixture(yield* EntryInferenceJournal, prepared.visualClaim)
      if (!admitted.dispatchAllowed) return yield* new JevEvidenceError({ message: 'Fixture claim cannot be repeated' })
    }
    return yield* evaluateAdmittedFixture(makeJevDispatch({ request, claimedAt, visualClaim: prepared.visualClaim }))
  })
