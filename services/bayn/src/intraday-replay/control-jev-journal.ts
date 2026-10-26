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
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  JevOutcome,
  type JevEvaluationRequest,
} from '../jev/evidence'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { JevFailure } from '../jev/contract'
import { decodeChartCheckpoint, verifyChartCheckpointHandoff } from '../jev/chart-checkpoint'
import { makeNativeChartEvidence } from '../jev/chart-evidence'
import { makeChartDecisionsRequest } from '../jev/chart-questions'
import { decodeEntryHandoff } from '../jev/entry-inference-evidence'
import { JevEvaluationStore } from '../jev/evaluation'
import { reproduceJevCandidateObservation } from '../jev/observation'
import { JevPurpose } from '../jev/portfolio'
import { JevEntryTargetSchema } from '../jev/decision'
import {
  decodeJevResolution,
  JevResolutionStatus,
  makeJevResolution,
  type JevEvaluationEvidence,
} from '../jev/resolution'
import { reproduceJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore, type CandidateObservation } from '../observe-composition/candidate-observation'
import { Sha256Schema, SymbolSchema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import type { ReplayInferenceCall } from './inference-timing'

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
    const calls: ReplayInferenceCall[] = []
    let interrupted = false
    const failure = (cause: unknown) =>
      operationalError({
        component: 'database',
        operation: 'control-jev-journal',
        message: 'Simulated control Jev evidence could not be durably verified',
        cause,
      })
    const atomic = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      permit
        .withPermit(
          Effect.gen(function* () {
            if (interrupted)
              return yield* failure(
                'Interrupted journal cannot be reused; preserve this experiment and use a new directory',
              )
            return yield* operation
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          ),
        )
        .pipe(Effect.mapError(failure))
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
        if (receipt?.outcome.status === JevOutcome.Completed) {
          const handoff = yield* Effect.fromResult(
            decodeEntryHandoff(
              {
                requestId: request.requestId,
                input: request.request,
                observedAt: request.observedAt,
                expiresAt: request.expiresAt,
              },
              yield* read('handoff', id),
            ),
          )
          if (handoff.handoffHash !== receipt.outcome.completion.handoff.handoffHash)
            return yield* failure('Terminal inference differs from its committed provider handoff')
        }
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
      record: (rawRequest, rawReceipt) =>
        atomic(
          Effect.gen(function* () {
            const request = yield* Effect.fromResult(decodeJevEvaluationRequest(rawRequest))
            const receipt = yield* Effect.fromResult(decodeJevEvaluationReceipt(request, rawReceipt))
            const saved = yield* requireEvaluation(request)
            if (
              receipt.outcome.status === JevOutcome.Failed &&
              receipt.outcome.failure === JevFailure.NotDispatched &&
              (yield* read('chart-claim', request.requestId)) !== null
            )
              return yield* failure('Undispatched receipt cannot omit a committed chart claim')
            if (receipt.outcome.status === JevOutcome.Completed) {
              const handoff = yield* Effect.fromResult(
                decodeEntryHandoff(
                  {
                    requestId: request.requestId,
                    input: request.request,
                    observedAt: request.observedAt,
                    expiresAt: request.expiresAt,
                  },
                  yield* read('handoff', request.requestId),
                ),
              )
              if (handoff.handoffHash !== receipt.outcome.completion.handoff.handoffHash)
                return yield* failure('Inference receipt has no identical committed provider handoff')
            }
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
                (authorityGenerationHash === undefined ||
                  saved.plan.authorityGenerationHash === authorityGenerationHash) &&
                saved.result === null
              )
                pending.push(id)
            }
            return pending.sort()
          }),
        ),
      begin: (raw, suppliedObservation) =>
        atomic(
          Effect.gen(function* () {
            const decoded = yield* Effect.fromResult(decodeJevBatchPlan(raw))
            yield* Effect.fromResult(reproduceJevTradingSignalBatch(suppliedObservation, decoded))
            yield* recordObservation({ contentHash: decoded.observationHash, payload: suppliedObservation })
            const observation = yield* readObservation(decoded.observationHash)
            const plan = yield* Effect.fromResult(reproduceJevTradingSignalBatch(observation, decoded))
            const saved = yield* readBatch(plan.batchId)
            if (saved !== null) return { ...saved, dispatches: [] }
            const claimedAt = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
            yield* write('batch', plan.batchId, plan)
            pendingBatches.add(plan.batchId)
            const dispatches = []
            for (const candidate of plan.candidates) {
              if (candidate.status === JevCandidatePlanStatus.Requested) {
                yield* write('request', candidate.request.requestId, candidate.request)
                plannedRequests.set(candidate.request.requestId, candidate.request)
                dispatches.push({ request: candidate.request, claimedAt })
              }
            }
            return { plan, result: null, dispatches }
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
    const recordObservation = ({ contentHash, payload }: CandidateObservation) =>
      Effect.gen(function* () {
        const observation = yield* Effect.fromResult(reproduceJevCandidateObservation(payload))
        if (
          observation.schemaVersion !== 'bayn.jev-observation.v1' ||
          observation.contentHash !== contentHash ||
          observation.portfolio.brokerState.account.accountId !== `research-control-${runId}` ||
          observation.cycleId !==
            (yield* Effect.fromResult(
              canonicalHashV1Result({ runId, sessionDate: observation.snapshot.manifest.sessionDate }),
            )) ||
          observation.authorityGenerationHash !==
            (yield* Effect.fromResult(
              canonicalHashV1Result({
                runId,
                scope: 'SIMULATED_CONTROL',
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
      })
    const observations: CandidateObservationStore['Service'] = {
      latestJevWindowEnd: ({ cycleId, purpose }) =>
        atomic(Effect.sync(() => Option.fromNullishOr(windows.get(`${cycleId}:${purpose}`)))),
      record: (observation) => atomic(recordObservation(observation)),
    }
    const handoffs: EntryInferenceJournal['Service'] = {
      recordChartClaim: (input) =>
        atomic(
          Effect.gen(function* () {
            const request = yield* Effect.fromResult(
              decodeJevEvaluationRequest(yield* read('request', input.requestId)),
            )
            yield* Effect.fromResult(decodeChartCheckpoint(request, { claim: input, terminal: null }))
            const existing = yield* read('chart-claim', input.requestId)
            if (existing !== null) {
              if (
                (yield* Effect.fromResult(canonicalHashV1Result(existing))) !==
                (yield* Effect.fromResult(canonicalHashV1Result(input)))
              )
                return yield* failure('Chart admission conflicts with committed evidence')
              return { dispatchAllowed: false }
            }
            const saved = yield* requireEvaluation(request)
            const now = yield* Clock.currentTimeMillis
            if (
              saved.resolution !== null ||
              now >= Date.parse(request.expiresAt) ||
              now < Date.parse(input.claimedAt) ||
              (yield* read('handoff', input.requestId)) !== null
            )
              return { dispatchAllowed: false }
            yield* write('chart-claim', input.requestId, input)
            return { dispatchAllowed: true }
          }),
        ),
      recordChartTerminal: (input) =>
        atomic(
          Effect.gen(function* () {
            const request = yield* read('request', input.requestId)
            const claim = yield* read('chart-claim', input.requestId)
            yield* Effect.fromResult(decodeChartCheckpoint(request, { claim, terminal: input }))
            const existing = yield* read('chart-terminal', input.requestId)
            if (existing === null) yield* write('chart-terminal', input.requestId, input)
            else if (
              (yield* Effect.fromResult(canonicalHashV1Result(existing))) !==
              (yield* Effect.fromResult(canonicalHashV1Result(input)))
            )
              return yield* failure('Chart terminal evidence is immutable')
          }),
        ),
      recordHandoff: (input) =>
        atomic(
          Effect.gen(function* () {
            const raw = yield* read('request', input.requestId)
            const request = yield* Effect.fromResult(decodeJevEvaluationRequest(raw))
            const handoff = yield* Effect.fromResult(
              decodeEntryHandoff(
                {
                  requestId: request.requestId,
                  input: request.request,
                  observedAt: request.observedAt,
                  expiresAt: request.expiresAt,
                },
                input,
              ),
            )
            const existing = yield* read('handoff', request.requestId)
            const chartClaim = yield* read('chart-claim', request.requestId)
            if (chartClaim !== null) {
              const checkpoint = yield* Effect.fromResult(
                decodeChartCheckpoint(request, {
                  claim: chartClaim,
                  terminal: yield* read('chart-terminal', request.requestId),
                }),
              )
              yield* Effect.fromResult(verifyChartCheckpointHandoff(checkpoint, handoff))
            }
            if (existing !== null) {
              if (
                (yield* Effect.fromResult(canonicalHashV1Result(existing))) !==
                (yield* Effect.fromResult(canonicalHashV1Result(handoff)))
              )
                return yield* failure('A committed provider handoff has different bytes')
              return { dispatchAllowed: false }
            }
            const saved = yield* requireEvaluation(request)
            yield* write('handoff', request.requestId, handoff)
            return { dispatchAllowed: saved.resolution === null }
          }),
        ),
    }
    return {
      handoffs,
      evaluations,
      batches: batchStore,
      observations,
      usable: Effect.sync(() => !interrupted),
      retainEntryDecision: (raw: unknown) =>
        atomic(
          Effect.gen(function* () {
            const decision = yield* Schema.decodeUnknownEffect(JevEntryTargetSchema, strictParseOptions)(raw)
            const storedBatch = yield* readBatch(decision.evidence.batchPlan.batchId)
            if (storedBatch?.result?.resultHash !== decision.evidence.batchResult.resultHash)
              return yield* failure('Entry decision has no identical committed batch result')
            const observation = yield* Effect.fromResult(
              reproduceJevCandidateObservation(yield* readObservation(decision.evidence.batchPlan.observationHash)),
            )
            if (
              observation.schemaVersion !== 'bayn.jev-observation.v1' ||
              observation.portfolio.purpose !== JevPurpose.Entry ||
              observation.portfolio.brokerState.account.accountId !== `research-control-${runId}`
            )
              return yield* failure('Entry decision belongs to another independent portfolio')
            const hash = yield* Effect.fromResult(canonicalHashV1Result(decision))
            yield* write('entry-decision', hash, decision)
            return hash
          }),
        ),
      calls: Effect.sync((): readonly ReplayInferenceCall[] => [...calls]),
      retainCall: (call: ReplayInferenceCall) =>
        atomic(
          Effect.gen(function* () {
            if ((yield* Effect.fromResult(canonicalHashV1Result(call.request))) !== call.requestHash)
              return yield* failure('Provider call differs from its sealed request bytes')
            const subject = Schema.Struct({ symbol: SymbolSchema })
            const { symbol } = yield* call.stage === 'CHART'
              ? Schema.decodeUnknownEffect(subject)(call.request.input[0].content[2].data)
              : Schema.decodeUnknownEffect(Schema.Struct({ candidate: subject }))(call.request.state).pipe(
                  Effect.map((value) => value.candidate),
                )
            const matches = []
            for (const request of plannedRequests.values()) {
              if (
                request.symbol !== symbol ||
                call.simulatedStartedAt < request.observedAt ||
                call.simulatedStartedAt >= request.expiresAt
              )
                continue
              if (call.stage === 'CHART') {
                const chart = yield* Effect.fromResult(makeNativeChartEvidence(request.request.chartSource))
                const expected = yield* Effect.fromResult(makeChartDecisionsRequest(chart))
                if (expected.requestHash !== call.requestHash) continue
              } else {
                const raw = yield* read('handoff', request.requestId)
                if (raw === null) continue
                const handoff = yield* Effect.fromResult(
                  decodeEntryHandoff(
                    {
                      requestId: request.requestId,
                      input: request.request,
                      observedAt: request.observedAt,
                      expiresAt: request.expiresAt,
                    },
                    raw,
                  ),
                )
                if (
                  handoff.disposition.status !== 'READY' ||
                  handoff.disposition.jevRequestHash !== call.requestHash ||
                  call.simulatedStartedAt < handoff.recordedAt
                )
                  continue
              }
              if ((yield* readEvaluation(request.requestId)) !== null) matches.push(request.requestId)
            }
            if (matches.length !== 1)
              return yield* failure(
                'Provider stage must bind exactly one committed parent request and dependent handoff',
              )
            const id = yield* Effect.fromResult(canonicalHashV1Result(call))
            yield* write('provider-call', id, call)
            calls.push(call)
          }),
        ),
    }
  })

export type ControlJevJournal = Effect.Success<ReturnType<typeof makeControlJevJournal>>
