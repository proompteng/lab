import { Effect } from 'effect'

import { operationalError } from '../errors'
import type { CandidateObservationStore } from '../observe-composition/candidate-observation'
import type { JevBatchEvidence, JevBatchStore } from '../jev/batch-evaluation'
import type { ExecutionProgramDependencies } from '../execution/runtime-program'
import { utcInstantFromEpochMillis } from '../time'
import { ReplayBrokerFailure } from './broker'

export interface ReplayObservationLatencyReceipt {
  readonly observationHash: string
  readonly commandIssuedAt: string
  readonly observedAt: string
  readonly completedAt: string
  readonly releaseFloorAt: string
  readonly releasedAt: string
}

export interface ReplayBatchLatencyReceipt {
  readonly batchId: string
  readonly resultHash: string
  readonly commandIssuedAt: string
  readonly batchObservedAt: string
  readonly completedAt: string
  readonly releaseFloorAt: string
  readonly releasedAt: string
}

export const replayDecisionReleaseAt = (issuedAt: number, completedAt: number, p95Ms: number): number | undefined => {
  const floor = issuedAt + p95Ms
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(completedAt) ||
    !Number.isSafeInteger(p95Ms) ||
    p95Ms < 0 ||
    issuedAt > completedAt ||
    Math.abs(issuedAt) > 8_640_000_000_000_000 ||
    Math.abs(completedAt) > 8_640_000_000_000_000 ||
    !Number.isSafeInteger(floor) ||
    Math.abs(floor) > 8_640_000_000_000_000
  )
    return undefined
  return Math.max(completedAt, floor)
}

/** The extra time delays consumption, so production expiry and pricing checks see the stressed clock. */
export const makeReplayDecisionLatency = (
  currentTime: ExecutionProgramDependencies['currentUtcInstant'],
  stress: {
    readonly p95FullBatchMs: number
    readonly advanceTo: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>
  } | null,
) => {
  let commandIssuedAt: string | undefined
  const admitted = new Map<string, string>()
  const receipts = new Map<string, ReplayBatchLatencyReceipt>()
  const admittedObservations = new Map<string, string>()
  const observationReceipts = new Map<string, ReplayObservationLatencyReceipt>()
  const fail = (message: string) =>
    operationalError({ component: 'strategy', operation: 'replay-decision-latency', message })
  const now = currentTime.pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'replay-decision-latency',
        message: 'Cannot read the latency-stressed replay clock',
        cause,
      }),
    ),
  )

  const runPass = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    stress === null
      ? operation
      : Effect.acquireUseRelease(
          Effect.gen(function* () {
            if (commandIssuedAt !== undefined) return yield* fail('Latency-stressed replay commands cannot overlap')
            const at = yield* now
            commandIssuedAt = at
          }),
          () => operation,
          () =>
            Effect.sync(() => {
              commandIssuedAt = undefined
            }),
        )

  const releaseTime = (issuedAt: string, observedAt: string, resultCompletedAt: string | null) =>
    Effect.gen(function* () {
      if (stress === null) return yield* fail('A release receipt requires the registered stress')
      const completedAt = yield* now
      const issuedAtMs = Date.parse(issuedAt)
      const completedAtMs = Date.parse(completedAt)
      const observedAtMs = Date.parse(observedAt)
      const resultCompletedAtMs = resultCompletedAt === null ? completedAtMs : Date.parse(resultCompletedAt)
      const requiredReleaseAt = replayDecisionReleaseAt(issuedAtMs, completedAtMs, stress.p95FullBatchMs)
      if (
        requiredReleaseAt === undefined ||
        !(issuedAtMs <= observedAtMs && observedAtMs <= resultCompletedAtMs && resultCompletedAtMs <= completedAtMs)
      )
        return yield* fail('Latency-stressed decision clocks are not causally ordered')
      if (requiredReleaseAt > completedAtMs)
        yield* stress.advanceTo(requiredReleaseAt).pipe(
          Effect.mapError((cause) =>
            operationalError({
              component: 'strategy',
              operation: 'replay-decision-latency',
              message: 'Cannot advance the registered latency stress',
              cause,
            }),
          ),
        )
      const releasedAt = yield* now
      if (Date.parse(releasedAt) < requiredReleaseAt)
        return yield* fail('Latency-stressed release did not reach its required clock')
      return {
        commandIssuedAt: issuedAt,
        completedAt,
        releaseFloorAt: utcInstantFromEpochMillis(issuedAtMs + stress.p95FullBatchMs),
        releasedAt,
      }
    })

  const release = <A extends JevBatchEvidence>(evidence: A) =>
    Effect.gen(function* () {
      if (stress === null || evidence.result === null) return evidence
      const issuedAt = admitted.get(evidence.plan.batchId)
      if (issuedAt === undefined)
        return yield* fail('Latency-stressed batch has no retained original command; restart the complete replay')
      const previous = receipts.get(evidence.plan.batchId)
      if (previous !== undefined) {
        if (previous.resultHash !== evidence.result.resultHash)
          return yield* fail('Latency-stressed batch changed its committed result')
        return evidence
      }
      const timing = yield* releaseTime(issuedAt, evidence.plan.observedAt, evidence.result.completedAt)
      receipts.set(evidence.plan.batchId, {
        batchId: evidence.plan.batchId,
        resultHash: evidence.result.resultHash,
        batchObservedAt: evidence.plan.observedAt,
        ...timing,
      })
      return evidence
    })

  const wrapObservations = (store: CandidateObservationStore['Service']): CandidateObservationStore['Service'] =>
    stress === null
      ? store
      : {
          ...store,
          record: (observation, momentumPolicy) =>
            momentumPolicy === undefined
              ? store.record(observation)
              : Effect.gen(function* () {
                  const issuedAt = admittedObservations.get(observation.contentHash) ?? commandIssuedAt
                  if (issuedAt === undefined)
                    return yield* fail('Momentum source admission is outside its replay command')
                  // Admit only after the authoritative PostgreSQL transaction commits; failed writes remain failed passes.
                  yield* store.record(observation, momentumPolicy)
                  admittedObservations.set(observation.contentHash, issuedAt)
                  const previous = observationReceipts.get(observation.contentHash)
                  if (previous !== undefined) return
                  const timing = yield* releaseTime(issuedAt, observation.payload.observedAt, null)
                  observationReceipts.set(observation.contentHash, {
                    observationHash: observation.contentHash,
                    observedAt: observation.payload.observedAt,
                    ...timing,
                  })
                }),
        }

  const wrapStore = (store: JevBatchStore['Service']): JevBatchStore['Service'] =>
    stress === null
      ? store
      : {
          ...store,
          begin: (plan, observation) =>
            Effect.gen(function* () {
              const issuedAt = admitted.get(plan.batchId) ?? commandIssuedAt
              if (issuedAt === undefined) return yield* fail('Batch admission is outside its replay command')
              const evidence = yield* store.begin(plan, observation)
              admitted.set(plan.batchId, issuedAt)
              return yield* release(evidence)
            }),
          finish: (batchId) => store.finish(batchId).pipe(Effect.flatMap(release)),
          complete: (plan, observation, result) =>
            store.complete(plan, observation, result).pipe(Effect.flatMap(release)),
        }

  return {
    runPass,
    wrapStore,
    wrapObservations,
    evidence: Effect.sync(() => ({
      admittedObservationCount: admittedObservations.size,
      unreleasedObservationHashes: [...admittedObservations.keys()].filter((id) => !observationReceipts.has(id)).sort(),
      observationReceipts: [...observationReceipts.values()].toSorted(
        (a, b) =>
          a.commandIssuedAt.localeCompare(b.commandIssuedAt) || a.observationHash.localeCompare(b.observationHash),
      ),
      admittedBatchCount: admitted.size,
      unreleasedBatchIds: [...admitted.keys()].filter((id) => !receipts.has(id)).sort(),
      receipts: [...receipts.values()].toSorted(
        (a, b) => a.commandIssuedAt.localeCompare(b.commandIssuedAt) || a.batchId.localeCompare(b.batchId),
      ),
    })),
  }
}
