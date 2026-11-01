import { Clock, Effect, Exit, FileSystem, Option, Result, Schema, Semaphore } from 'effect'

import { operationalError, type OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import {
  decodeJevBatchPlan,
  decodeJevBatchResult,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
  type JevBatchPlan,
  type JevBatchResult,
} from '../jev/batch'
import { type JevBatchEvidence, JevBatchStore } from '../jev/batch-evaluation'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  JevOutcome,
  type JevEvaluationRequest,
} from '../jev/evidence'
import {
  EntryInferenceJournal,
  prepareClaimedEntry,
  type EntryHandoff,
  type EntryStageTransition,
} from '../jev/entry-inference'
import { JevFailure } from '../jev/contract'
import { decodeStagedCheckpoint, type StagedDispatchClaim, type StagedTerminalReceipt } from '../jev/staged-checkpoint'
import { verifyStagedCheckpointHandoff } from '../jev/staged-inference-cost-evidence'
import { decodeEntryHandoff } from '../jev/entry-inference-evidence'
import { JevEvaluationStore, makeJevDispatch } from '../jev/evaluation'
import { reproduceJevCandidateObservation } from '../jev/observation'
import { JevPurpose } from '../jev/portfolio'
import { JevEntryTargetSchema } from '../jev/decision'
import {
  decodeJevResolution,
  JevResolutionStatus,
  makeJevResolution,
  type JevEvaluationEvidence,
} from '../jev/resolution'
import { reproduceJevTradingSignalBatch, reproduceJevTradingSignalBatchEvidence } from '../jev/trading-signals'
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
    const recordEvaluation = (
      rawRequest: JevEvaluationRequest,
      rawReceipt: import('../jev/evidence').JevEvaluationReceipt,
    ) =>
      Effect.gen(function* () {
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(rawRequest))
        const receipt = yield* Effect.fromResult(decodeJevEvaluationReceipt(request, rawReceipt))
        const saved = yield* requireEvaluation(request)
        if (
          receipt.outcome.status === JevOutcome.Failed &&
          receipt.outcome.failure === JevFailure.NotDispatched &&
          (yield* read('visual-claim-CHART', request.requestId)) !== null
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
      })
    const evaluations: JevEvaluationStore['Service'] = {
      read: (id) => atomic(readEvaluation(id)),
      recordAll: (entries) =>
        permit
          .withPermit(
            Effect.gen(function* () {
              const resolutions = new Map<string, import('../jev/resolution').JevResolution>()
              for (const entry of entries)
                resolutions.set(entry.request.requestId, yield* recordEvaluation(entry.request, entry.receipt))
              return resolutions
            }),
          )
          .pipe(Effect.mapError(failure)),
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
    const readBatchSource = (decoded: JevBatchPlan) =>
      Effect.gen(function* () {
        const raw = yield* read('observation', decoded.observationHash)
        if (raw === null) return yield* failure('Batch observation is missing')
        // Reproduce the freshly read bytes once; the result proves both the source hash and batch identity.
        const { observation, plan } = yield* Effect.fromResult(reproduceJevTradingSignalBatchEvidence(raw, decoded))
        if (observation.contentHash !== decoded.observationHash) return yield* failure('Observation hash differs')
        return plan
      })
    const readBatch = (id: string): Effect.Effect<JevBatchEvidence | null, OperationalError> =>
      Effect.gen(function* () {
        const raw = yield* read('batch', id)
        if (raw === null) return null
        const decoded = yield* Effect.fromResult(decodeJevBatchPlan(raw))
        const plan = yield* readBatchSource(decoded)
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
            const plan = yield* readBatchSource(decoded)
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
                const initial = yield* Effect.fromResult(
                  prepareClaimedEntry({
                    requestId: candidate.request.requestId,
                    input: candidate.request.request,
                    observedAt: candidate.request.observedAt,
                    expiresAt: candidate.request.expiresAt,
                    claimedAt,
                  }),
                )
                if (initial.visualClaim !== null) {
                  const admitted = yield* recordClaim(initial.visualClaim)
                  if (!admitted.dispatchAllowed)
                    return yield* failure('Initial visual claim was not admitted with its request')
                }
                dispatches.push(
                  makeJevDispatch({ request: candidate.request, claimedAt, visualClaim: initial.visualClaim }),
                )
              }
            }
            return { plan, result: null, dispatches }
          }),
        ),
      complete: (plan, observation, result) =>
        atomic(
          Effect.gen(function* () {
            yield* Effect.fromResult(reproduceJevTradingSignalBatch(observation, plan))
            yield* Effect.fromResult(decodeJevBatchResult(plan, result))
            const saved = yield* readBatch(plan.batchId)
            if (saved === null) return yield* failure('Completion has no admitted batch')
            yield* same(saved.plan, plan)
            for (const candidate of result.candidates) {
              if (candidate.status === JevCandidateResultStatus.Excluded) continue
              const request = plan.candidates.find((item) => item.symbol === candidate.symbol)
              if (
                request?.status !== JevCandidatePlanStatus.Requested ||
                candidate.status !== JevCandidateResultStatus.Resolved ||
                candidate.receipt === null
              )
                return yield* failure('Batch completion is missing a requested receipt')
              const resolution = yield* recordEvaluation(request.request, candidate.receipt)
              yield* same(resolution, candidate.resolution)
            }
            if (saved.result !== null) {
              yield* same(saved.result.candidates, result.candidates)
              return saved
            }
            yield* write('batch-result', plan.batchId, result)
            pendingBatches.delete(plan.batchId)
            return { plan, result }
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
    const staged = (request: JevEvaluationRequest) =>
      Effect.gen(function* () {
        const claims = [],
          terminals = [],
          skips = []
        for (const stage of ['CHART', 'BASE_START']) {
          const claim = yield* read(`visual-claim-${stage}`, request.requestId)
          const terminal = yield* read(`visual-terminal-${stage}`, request.requestId)
          if (claim !== null) claims.push(claim)
          if (terminal !== null) terminals.push(terminal)
        }
        const skip = yield* read('base-start-skip', request.requestId)
        if (skip !== null) skips.push(skip)
        return yield* Effect.fromResult(decodeStagedCheckpoint(request, { claims, terminals, skips }))
      })
    const same = (left: unknown, right: unknown) =>
      Effect.gen(function* () {
        if (
          (yield* Effect.fromResult(canonicalHashV1Result(left))) !==
          (yield* Effect.fromResult(canonicalHashV1Result(right)))
        )
          return yield* failure('Committed visual journal evidence is immutable')
      })
    const recordClaim = (input: StagedDispatchClaim) =>
      Effect.gen(function* () {
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(yield* read('request', input.requestId)))
        const checkpoint = yield* staged(request)
        yield* Effect.fromResult(
          decodeStagedCheckpoint(request, {
            ...checkpoint,
            claims: [...checkpoint.claims.filter((row) => row.stage !== input.stage), input],
          }),
        )
        const existing = yield* read(`visual-claim-${input.stage}`, input.requestId)
        if (existing !== null) {
          yield* same(existing, input)
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
        yield* write(`visual-claim-${input.stage}`, input.requestId, input)
        return { dispatchAllowed: true }
      })
    const recordTerminal = (input: StagedTerminalReceipt) =>
      Effect.gen(function* () {
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(yield* read('request', input.requestId)))
        const checkpoint = yield* staged(request)
        yield* Effect.fromResult(
          decodeStagedCheckpoint(request, {
            ...checkpoint,
            terminals: [...checkpoint.terminals.filter((row) => row.stage !== input.stage), input],
          }),
        )
        const existing = yield* read(`visual-terminal-${input.stage}`, input.requestId)
        if (existing === null) yield* write(`visual-terminal-${input.stage}`, input.requestId, input)
        else yield* same(existing, input)
      })
    const recordHandoff = (input: EntryHandoff) =>
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
        const skip = handoff.baseStart?.status === 'NOT_REQUESTED' ? handoff.baseStart.skip : undefined
        if (skip !== undefined) {
          const checkpoint = yield* staged(request)
          yield* Effect.fromResult(decodeStagedCheckpoint(request, { ...checkpoint, skips: [skip] }))
          const stored = yield* read('base-start-skip', input.requestId)
          if (stored === null) yield* write('base-start-skip', input.requestId, skip)
          else yield* same(stored, skip)
        }
        const existing = yield* read('handoff', request.requestId)
        yield* Effect.fromResult(verifyStagedCheckpointHandoff(yield* staged(request), handoff))
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
      })
    const transitionId = (input: EntryStageTransition) =>
      input.terminal === null ? input.successor.handoff.requestId : input.terminal.requestId
    const retainTerminals = (inputs: readonly EntryStageTransition[]) =>
      permit
        .withPermit(
          Effect.forEach(
            inputs.flatMap((input) => (input.terminal === null ? [] : [input.terminal])),
            recordTerminal,
            { discard: true },
          ),
        )
        .pipe(Effect.mapError(failure))
    const handoffs: EntryInferenceJournal['Service'] = {
      recordVisualClaims: (inputs) =>
        atomic(
          Effect.forEach(inputs, (input) =>
            Effect.gen(function* () {
              return { requestId: input.requestId, ...(yield* recordClaim(input)) }
            }),
          ),
        ),
      recordTransitions: (inputs) =>
        inputs.every((input) => input.successor.kind === 'NONE')
          ? retainTerminals(inputs).pipe(
              Effect.as(inputs.map((input) => ({ requestId: transitionId(input), dispatchAllowed: false }))),
            )
          : atomic(
              Effect.forEach(inputs, ({ terminal, successor }) =>
                Effect.gen(function* () {
                  if (terminal === null)
                    return { requestId: successor.handoff.requestId, ...(yield* recordHandoff(successor.handoff)) }
                  if (
                    (successor.kind === 'VISUAL' &&
                      (terminal.stage !== 'CHART' ||
                        successor.claim.stage !== 'BASE_START' ||
                        successor.claim.requestId !== terminal.requestId)) ||
                    (successor.kind === 'HANDOFF' && successor.handoff.requestId !== terminal.requestId)
                  )
                    return yield* failure('A visual successor must belong to its terminal request and stage')
                  yield* recordTerminal(terminal)
                  const admission =
                    successor.kind === 'NONE'
                      ? { dispatchAllowed: false }
                      : successor.kind === 'VISUAL'
                        ? yield* recordClaim(successor.claim)
                        : yield* recordHandoff(successor.handoff)
                  return { requestId: terminal.requestId, ...admission }
                }),
              ),
            ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? retainTerminals(inputs) : Effect.void))),
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
            const { symbol } = yield* call.stage !== 'JEV'
              ? call.stage === 'CHART'
                ? Schema.decodeUnknownEffect(subject)(call.request.input[0].content[2].data)
                : Schema.decodeUnknownEffect(Schema.Struct({ source: subject }))(
                    call.request.input[0].content[2].data,
                  ).pipe(Effect.map((value) => value.source))
              : Schema.decodeUnknownEffect(subject)(call.request.state)
            const matches = []
            for (const request of plannedRequests.values()) {
              if (
                request.symbol !== symbol ||
                call.simulatedStartedAt < request.observedAt ||
                call.simulatedStartedAt >= request.expiresAt
              )
                continue
              if (call.stage !== 'JEV') {
                const checkpoint = yield* staged(request)
                const claim = checkpoint.claims.find((row) => row.stage === call.stage)
                if (
                  claim === undefined ||
                  claim.providerRequestHash !== call.requestHash ||
                  call.simulatedStartedAt < claim.claimedAt
                )
                  continue
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
