import { Clock, Effect, FileSystem, Option, Result, Schema, Semaphore } from 'effect'

import { operationalError, type OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import {
  decodeJevBatchPlan,
  decodeJevBatchResult,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
  type JevBatchResult,
} from '../jev/batch'
import { type JevBatchEvidence, JevBatchStore } from '../jev/batch-evaluation'
import { decodeJevEvaluationReceipt, decodeJevEvaluationRequest, type JevEvaluationRequest } from '../jev/evidence'
import { JevClaim, JevEvaluationStore } from '../jev/evaluation'
import { reproduceJevCandidateObservation } from '../jev/observation'
import { JevPurpose } from '../jev/portfolio'
import {
  decodeJevResolution,
  JevResolutionStatus,
  makeJevResolution,
  type JevEvaluationEvidence,
} from '../jev/resolution'
import { reproduceJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import type { ReplayJevCall } from './jev-timing'

const TerminalSchema = Schema.Struct({ receipt: Schema.NullOr(Schema.Unknown), resolution: Schema.Unknown })

export const makeControlJevJournal = (directory: string, runId: string) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Sha256Schema)(runId)
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(directory)
    const permit = yield* Semaphore.make(1)
    const pendingBatches = new Set<string>()
    const plannedRequests = new Map<string, JevEvaluationRequest>()
    const windows = new Map<string, string>()
    const calls: ReplayJevCall[] = []
    const failure = (cause: unknown) =>
      operationalError({
        component: 'database',
        operation: 'control-jev-journal',
        message: 'Simulated control Jev evidence could not be durably verified',
        cause,
      })
    const atomic = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      permit.withPermit(Effect.uninterruptible(operation)).pipe(Effect.mapError(failure))
    const filePath = (kind: string, id: string) => `${directory}/${kind}-${id}.json`
    const read = (kind: string, id: string) =>
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(Sha256Schema)(id)
        const path = filePath(kind, id)
        return (yield* fs.exists(path))
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(yield* fs.readFileString(path))
          : null
      })
    const write = (kind: string, id: string, value: unknown) =>
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(Sha256Schema)(id)
        const text = yield* Effect.fromResult(Result.try({ try: () => JSON.stringify(value), catch: failure }))
        if (text === undefined) return yield* failure('Journal value cannot be serialized')
        yield* Effect.gen(function* () {
          const file = yield* fs.open(filePath(kind, id), { flag: 'wx' })
          yield* file.writeAll(new TextEncoder().encode(`${text}\n`))
          yield* file.sync
          const parent = yield* fs.open(directory, { flag: 'r' })
          yield* parent.sync
        }).pipe(Effect.scoped)
      })
    const readEvaluation = (id: string): Effect.Effect<JevEvaluationEvidence | null, OperationalError> =>
      Effect.gen(function* () {
        const raw = yield* read('request', id)
        if (raw === null) return null
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(raw))
        if (request.requestId !== id) return yield* failure('Stored request identity differs')
        const terminal = yield* read('terminal', id)
        if (terminal === null) return { request, receipt: null, resolution: null }
        const decoded = yield* Schema.decodeUnknownEffect(TerminalSchema, strictParseOptions)(terminal)
        const late = yield* read('late-receipt', id)
        const rawReceipt = late ?? decoded.receipt
        const receipt =
          rawReceipt === null ? null : yield* Effect.fromResult(decodeJevEvaluationReceipt(request, rawReceipt))
        const resolution = yield* Effect.fromResult(decodeJevResolution(request, receipt, decoded.resolution))
        if (late !== null && resolution.status !== JevResolutionStatus.Abandoned)
          return yield* failure('Only an abandoned request may retain a late receipt')
        return { request, receipt, resolution }
      }).pipe(Effect.mapError(failure))
    const requireEvaluation = (request: JevEvaluationRequest) =>
      Effect.gen(function* () {
        const evidence = yield* readEvaluation(request.requestId)
        if (
          evidence === null ||
          (yield* Effect.fromResult(canonicalHashV1Result(evidence.request))) !==
            (yield* Effect.fromResult(canonicalHashV1Result(request)))
        )
          return yield* failure('Evaluation has no identical committed request')
        return evidence
      })
    const abandon = (request: JevEvaluationRequest, abandonedAt: string) =>
      Effect.gen(function* () {
        const evidence = yield* requireEvaluation(request)
        if (evidence.resolution !== null) return evidence.resolution
        const resolution = yield* Effect.fromResult(
          makeJevResolution(request, null, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Abandoned,
            abandonedAt,
          }),
        )
        yield* write('terminal', request.requestId, { receipt: null, resolution })
        return resolution
      })
    const evaluations: JevEvaluationStore['Service'] = {
      read: (id) => atomic(readEvaluation(id)),
      begin: (raw) =>
        atomic(
          Effect.gen(function* () {
            const request = yield* Effect.fromResult(decodeJevEvaluationRequest(raw))
            const planned = plannedRequests.get(request.requestId)
            if (
              planned === undefined ||
              (yield* Effect.fromResult(canonicalHashV1Result(planned))) !==
                (yield* Effect.fromResult(canonicalHashV1Result(request)))
            )
              return yield* failure('Inference requires its committed native batch')
            const saved = yield* readEvaluation(request.requestId)
            if (saved === null) {
              yield* write('request', request.requestId, request)
              return { status: JevClaim.Acquired } as const
            }
            if (saved.resolution === null) return { status: JevClaim.Pending } as const
            if (saved.resolution.status === JevResolutionStatus.Abandoned)
              return { status: JevClaim.Abandoned, resolution: saved.resolution } as const
            if (saved.receipt === null) return yield* failure('Recorded request lacks its receipt')
            return { status: JevClaim.Recorded, receipt: saved.receipt, resolution: saved.resolution } as const
          }),
        ),
      record: (rawRequest, rawReceipt) =>
        atomic(
          Effect.gen(function* () {
            const request = yield* Effect.fromResult(decodeJevEvaluationRequest(rawRequest))
            const receipt = yield* Effect.fromResult(decodeJevEvaluationReceipt(request, rawReceipt))
            const saved = yield* requireEvaluation(request)
            if (saved.receipt !== null && saved.receipt.receiptHash !== receipt.receiptHash)
              return yield* failure('A committed request has a different receipt')
            if (saved.resolution !== null) {
              if (saved.receipt === null) yield* write('late-receipt', request.requestId, receipt)
              return saved.resolution
            }
            const resolution = yield* Effect.fromResult(
              makeJevResolution(request, receipt, {
                schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                requestId: request.requestId,
                status: JevResolutionStatus.Recorded,
                receiptHash: receipt.receiptHash,
              }),
            )
            yield* write('terminal', request.requestId, { receipt, resolution })
            return resolution
          }),
        ),
      abandon: (request, at) => atomic(abandon(request, at)),
    }
    const readObservation = (id: string) =>
      Effect.gen(function* () {
        const raw = yield* read('observation', id)
        if (raw === null) return yield* failure('Batch observation is missing')
        const observation = yield* Effect.fromResult(reproduceJevCandidateObservation(raw))
        if (observation.contentHash !== id) return yield* failure('Observation hash differs')
        return raw
      })
    const readBatch = (id: string): Effect.Effect<JevBatchEvidence | null, OperationalError> =>
      Effect.gen(function* () {
        const raw = yield* read('batch', id)
        if (raw === null) return null
        const decoded = yield* Effect.fromResult(decodeJevBatchPlan(raw))
        const observation = yield* readObservation(decoded.observationHash)
        const plan = yield* Effect.fromResult(reproduceJevTradingSignalBatch(observation, decoded))
        if (plan.batchId !== id) return yield* failure('Batch identity differs')
        const rawResult = yield* read('batch-result', id)
        if (rawResult === null) return { plan, result: null }
        const result = yield* Effect.fromResult(decodeJevBatchResult(plan, rawResult))
        for (const candidate of result.candidates) {
          if (candidate.status === JevCandidateResultStatus.Excluded) continue
          const evidence = yield* readEvaluation(candidate.requestId)
          if (candidate.status === JevCandidateResultStatus.Unattempted) {
            if (evidence !== null) return yield* failure('An unattempted candidate has a committed request')
          } else if (
            evidence?.resolution?.resolutionHash !== candidate.resolution.resolutionHash ||
            (candidate.receipt !== null && evidence.receipt?.receiptHash !== candidate.receipt.receiptHash)
          )
            return yield* failure('Batch result differs from committed candidate evidence')
        }
        return { plan, result }
      }).pipe(Effect.mapError(failure))
    const batchStore: JevBatchStore['Service'] = {
      read: (id) => atomic(readBatch(id)),
      pending: (cycleId, authorityGenerationHash) =>
        atomic(
          Effect.gen(function* () {
            const pending: string[] = []
            for (const id of pendingBatches) {
              const saved = yield* readBatch(id)
              if (
                saved?.plan.cycleId === cycleId &&
                saved.plan.authorityGenerationHash === authorityGenerationHash &&
                saved.result === null
              )
                pending.push(id)
            }
            return pending.sort()
          }),
        ),
      begin: (raw) =>
        atomic(
          Effect.gen(function* () {
            const decoded = yield* Effect.fromResult(decodeJevBatchPlan(raw))
            const observation = yield* readObservation(decoded.observationHash)
            const plan = yield* Effect.fromResult(reproduceJevTradingSignalBatch(observation, decoded))
            const saved = yield* readBatch(plan.batchId)
            if (saved !== null) return saved
            yield* write('batch', plan.batchId, plan)
            pendingBatches.add(plan.batchId)
            for (const candidate of plan.candidates)
              if (candidate.status === JevCandidatePlanStatus.Requested)
                plannedRequests.set(candidate.request.requestId, candidate.request)
            return { plan, result: null }
          }),
        ),
      finish: (id) =>
        atomic(
          Effect.gen(function* () {
            const saved = yield* readBatch(id)
            if (saved === null) return yield* failure('Cannot finish an absent batch')
            if (saved.result !== null) return saved
            const now = yield* Clock.currentTimeMillis
            if (now < Date.parse(saved.plan.observedAt)) return yield* failure('Batch clock precedes its observation')
            const evidence = new Map<string, JevEvaluationEvidence | null>()
            for (const candidate of saved.plan.candidates) {
              if (candidate.status === JevCandidatePlanStatus.Excluded) continue
              const value = yield* readEvaluation(candidate.request.requestId)
              if (now < Date.parse(saved.plan.expiresAt) && value?.resolution == null) return saved
              evidence.set(candidate.request.requestId, value)
            }
            const completedAt = utcInstantFromEpochMillis(now)
            const candidates: JevBatchResult['candidates'][number][] = []
            for (const candidate of saved.plan.candidates) {
              if (candidate.status === JevCandidatePlanStatus.Excluded) {
                candidates.push({ symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded })
                continue
              }
              const value = evidence.get(candidate.request.requestId)
              if (value == null) {
                candidates.push({
                  symbol: candidate.symbol,
                  status: JevCandidateResultStatus.Unattempted,
                  requestId: candidate.request.requestId,
                })
                continue
              }
              const resolution = value.resolution ?? (yield* abandon(candidate.request, completedAt))
              candidates.push({
                symbol: candidate.symbol,
                status: JevCandidateResultStatus.Resolved,
                requestId: candidate.request.requestId,
                receipt: value.receipt,
                resolution,
              })
            }
            const result = yield* Effect.fromResult(
              makeJevBatchResult(saved.plan, {
                schemaVersion: 'bayn.jev-batch-result.v1',
                batchId: id,
                completedAt,
                candidates,
              }),
            )
            yield* write('batch-result', id, result)
            pendingBatches.delete(id)
            return { plan: saved.plan, result }
          }),
        ),
    }
    const observations: CandidateObservationStore['Service'] = {
      latestJevWindowEnd: ({ cycleId, purpose }) =>
        Effect.sync(() => Option.fromNullishOr(windows.get(`${cycleId}:${purpose}`))),
      record: ({ contentHash, payload }) =>
        atomic(
          Effect.gen(function* () {
            const observation = yield* Effect.fromResult(reproduceJevCandidateObservation(payload))
            if (
              observation.schemaVersion !== 'bayn.jev-observation.v1' ||
              observation.contentHash !== contentHash ||
              observation.portfolio.purpose !== JevPurpose.Manage ||
              observation.portfolio.brokerState.account.accountId !== `research-control-management-${runId}` ||
              observation.cycleId !==
                (yield* Effect.fromResult(
                  canonicalHashV1Result({ runId, sessionDate: observation.snapshot.manifest.sessionDate }),
                )) ||
              observation.authorityGenerationHash !==
                (yield* Effect.fromResult(
                  canonicalHashV1Result({
                    runId,
                    scope: 'SIMULATED_CONTROL_MANAGEMENT',
                    protocol: observation.protocol,
                  }),
                ))
            )
              return yield* failure('Observation does not belong to this simulated control')
            const existing = yield* read('observation', contentHash)
            if (existing === null) yield* write('observation', contentHash, payload)
            else yield* readObservation(contentHash)
            const key = `${observation.cycleId}:${observation.portfolio.purpose}`
            const previous = windows.get(key)
            if (previous === undefined || previous < observation.snapshot.manifest.rangeEndAt)
              windows.set(key, observation.snapshot.manifest.rangeEndAt)
          }),
        ),
    }
    return {
      evaluations,
      batches: batchStore,
      observations,
      calls: Effect.sync((): readonly ReplayJevCall[] => [...calls]),
      retainCall: (call: ReplayJevCall) =>
        atomic(
          Effect.gen(function* () {
            const request = [...plannedRequests.values()].find((value) => value.requestHash === call.requestHash)
            if (request === undefined || (yield* readEvaluation(request.requestId)) === null)
              return yield* failure('Provider call has no committed request')
            const id = yield* Effect.fromResult(canonicalHashV1Result(call))
            yield* write('provider-call', id, call)
            calls.push(call)
          }),
        ),
    }
  })

export type ControlJevJournal = Effect.Success<ReturnType<typeof makeControlJevJournal>>
