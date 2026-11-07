import { JevEvaluationStore, type JevDispatch } from './evaluation'
import { JevOutcome, makeJevEvaluationReceipt, type JevEvaluationRequest } from './evidence'
import { Cause, Clock, Effect, Exit, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import { JevClient, type JevError } from './client'
import { decodeJevResponse, JevFailure, JevResponseSchema } from './contract'
import {
  deriveEntryHandoffDisposition,
  EntryInferenceError,
  EntryInferenceJournal,
  prepareClaimedEntry,
  type EntryHandoff,
  type EntryInferenceClaim,
  type EntryInferenceCompletion,
  type EntryStageTransition,
} from './entry-inference'
import { logCommittedEntryHandoff } from './entry-inference-diagnostics'
import { makeStagedTerminalReceipt, type StagedDispatchClaim, type StagedTerminalReceipt } from './staged-checkpoint'

type PreparedEntry = Result.Result.Success<ReturnType<typeof prepareClaimedEntry>>
type Work = PreparedEntry & {
  terminal: StagedTerminalReceipt | null
  terminalCommitted: boolean
  readonly request: JevEvaluationRequest
  completion: EntryInferenceCompletion | null
}
const parallel = <A, B, E, R>(values: readonly A[], run: (value: A) => Effect.Effect<B, E, R>) =>
  Effect.gen(function* () {
    // Settle the bounded provider calls before propagating an error, retaining every paid response.
    const exits = yield* Effect.forEach(values, (value) => Effect.exit(run(value)), {
      concurrency: Math.max(1, values.length),
    })
    const results: B[] = []
    for (const exit of exits) {
      if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
      results.push(exit.value)
    }
    return results
  })

const visual = (work: Work, claim: StagedDispatchClaim, request: PreparedEntry['visualRequest']) =>
  Effect.gen(function* () {
    const dispatchAt = yield* Clock.currentTimeMillis
    const expires = Date.parse(work.claim.expiresAt)
    if (dispatchAt < Date.parse(claim.claimedAt))
      return yield* new EntryInferenceError({
        category: 'DEADLINE',
        message: 'Entry inference clock regressed after admission',
      })
    let outcome: StagedTerminalReceipt['outcome']
    if (dispatchAt >= expires)
      return yield* new EntryInferenceError({
        category: 'DEADLINE',
        message: 'Original evidence window expired while committing visual admission',
      })
    const client = yield* JevClient
    const response = yield* client.evaluate(request.request, expires - dispatchAt).pipe(
      Effect.timeoutOrElse({
        duration: expires - dispatchAt,
        orElse: () =>
          Effect.fail(
            new EntryInferenceError({
              category: 'DEADLINE',
              message: 'Original evidence window expired during visual inference',
            }),
          ),
      }),
      Effect.result,
    )
    const returnedAt = yield* Clock.currentTimeMillis
    if (Result.isFailure(response)) {
      const failure = response.failure
      outcome = {
        status: 'FAILED',
        failure:
          failure instanceof EntryInferenceError
            ? { category: 'DEADLINE', httpStatus: null, responseHash: null, usage: null }
            : {
                category:
                  failure.failure === JevFailure.Timeout
                    ? 'DEADLINE'
                    : failure.failure === JevFailure.NotDispatched
                      ? 'REQUEST'
                      : failure.failure,
                httpStatus: failure.status ?? null,
                responseHash: failure.requestHash === request.requestHash ? (failure.responseHash ?? null) : null,
                usage:
                  failure.requestHash === request.requestHash && failure.rejectedResponse !== undefined
                    ? (() => {
                        const decoded = Schema.decodeUnknownResult(
                          Schema.Struct({
                            model: JevResponseSchema.fields.model,
                            usage: JevResponseSchema.fields.usage,
                          }),
                        )(Redacted.value(failure.rejectedResponse))
                        return Result.isSuccess(decoded) ? decoded.success.usage : null
                      })()
                    : null,
              },
      }
    } else {
      const received = response.success
      const responseHash = yield* Effect.fromResult(canonicalHashV1Result(received.response))
      if (
        received.requestHash !== request.requestHash ||
        received.responseHash !== responseHash ||
        Date.parse(received.startedAt) < dispatchAt ||
        received.completedAt < received.startedAt ||
        Date.parse(received.completedAt) > returnedAt
      )
        return yield* new EntryInferenceError({
          category: 'INPUT',
          message: 'Visual response does not match its dispatch claim',
        })
      outcome = { status: 'RECEIVED', inference: received }
    }
    const terminal = yield* Effect.fromResult(
      makeStagedTerminalReceipt({
        schemaVersion: 'bayn.staged-terminal-receipt.v1',
        stage: claim.stage,
        requestId: claim.requestId,
        claimHash: claim.claimHash,
        recordedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
        outcome,
      }),
    )
    work.terminal = terminal
    return terminal
  })

const handoff = (work: Work, terminal: StagedTerminalReceipt | null) =>
  Effect.gen(function* () {
    let disposition: EntryHandoff['disposition']
    if (terminal === null) disposition = { status: 'SOURCE_INFEASIBLE' }
    else if (terminal.outcome.status === 'FAILED')
      disposition = { status: 'VISUAL_FAILED', failure: terminal.outcome.failure }
    else {
      const derived = deriveEntryHandoffDisposition(work.prepared.input, terminal.outcome.inference)
      disposition = Result.isSuccess(derived)
        ? derived.success
        : {
            status: 'PREPARATION_FAILED',
            visual: terminal.outcome.inference,
            reason: 'DERIVATION_CONTRACT',
          }
    }
    const material = {
      schemaVersion: 'bayn.entry-handoff.v5' as const,
      requestId: work.claim.requestId,
      inputHash: work.prepared.requestHash,
      visualRequestHash: work.visualRequest.requestHash,
      recordedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
      disposition,
    }
    return { ...material, handoffHash: yield* Effect.fromResult(canonicalHashV1Result(material)) }
  })

export const evaluateClaimedEntryInferences = (dispatches: readonly JevDispatch[]) =>
  Effect.gen(function* () {
    const journal = yield* EntryInferenceJournal
    const work: Work[] = yield* Effect.forEach(dispatches, (dispatch) =>
      Effect.gen(function* () {
        yield* dispatch.consume
        const request = yield* Effect.try({
          try: () => structuredClone(dispatch.request),
          catch: (cause) =>
            new EntryInferenceError({
              category: 'INPUT',
              message: 'Admitted entry cannot be privately retained',
              cause,
            }),
        })
        const claim = {
          requestId: request.requestId,
          input: request.request,
          observedAt: request.observedAt,
          expiresAt: request.expiresAt,
          claimedAt: dispatch.claimedAt,
        }
        const prepared = yield* Effect.fromResult(prepareClaimedEntry(claim))
        if (
          (yield* Effect.fromResult(canonicalHashV1Result(prepared.visualClaim))) !==
          (yield* Effect.fromResult(canonicalHashV1Result(dispatch.visualClaim)))
        )
          return yield* new EntryInferenceError({
            category: 'INPUT',
            message: 'Initial visual dispatch differs from its admitted claim',
          })
        return { ...prepared, request, completion: null, terminal: null, terminalCommitted: false }
      }),
    )
    const commit = (transitions: readonly EntryStageTransition[]) =>
      Effect.gen(function* () {
        if (transitions.length === 0) return
        const admissions = yield* journal.recordTransitions(transitions)
        for (const transition of transitions) {
          const requestId =
            transition.terminal === null ? transition.successor.handoff.requestId : transition.terminal.requestId
          if (transition.terminal !== null) {
            const owner = work.find((entry) => entry.claim.requestId === requestId)
            if (owner !== undefined) owner.terminalCommitted = true
          }
          if (admissions.find((entry) => entry.requestId === requestId)?.dispatchAllowed !== true)
            return yield* new EntryInferenceError({
              category: 'EXISTING_HANDOFF',
              message: 'An existing stage admission cannot be dispatched again',
            })
        }
        // Only newly admitted, durably committed handoffs are logged. Replays retain
        // the existing refusal above; handoffHash permits downstream deduplication.
        for (const transition of transitions) {
          if (transition.successor.kind !== 'HANDOFF') continue
          const committed = transition.successor.handoff
          const owner = work.find((entry) => entry.claim.requestId === committed.requestId)
          if (owner !== undefined)
            yield* logCommittedEntryHandoff(owner.request.cycleId, committed, owner.sourceFeasibility)
        }
      })
    return yield* Effect.gen(function* () {
      yield* parallel(work, (entry) =>
        Effect.gen(function* () {
          const terminal =
            entry.visualClaim === null ? null : yield* visual(entry, entry.visualClaim, entry.visualRequest)
          const ready = yield* handoff(entry, terminal)
          yield* commit([{ terminal, successor: { kind: 'HANDOFF', handoff: ready } }])
          entry.completion = yield* evaluateHandedOffEntry(entry.claim, ready)
        }),
      )
      return yield* Effect.forEach(work, (entry) =>
        entry.completion === null
          ? Effect.fail(
              new EntryInferenceError({
                category: 'INPUT',
                message: 'Committed handoffs do not cover the admitted batch',
              }),
            )
          : Effect.succeed(entry.completion),
      )
    }).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void
        const uncommitted = work.flatMap((entry) =>
          entry.terminal === null || entry.terminalCommitted ? [] : [entry.terminal],
        )
        return Effect.gen(function* () {
          // Independent evidence sinks must both be attempted, even when the
          // terminal journal is unavailable. Retain every failure in the cause.
          const terminalExit = yield* Effect.exit(
            uncommitted.length > 0
              ? journal.recordTransitions(
                  uncommitted.map((terminal) => ({ terminal, successor: { kind: 'NONE' as const } })),
                )
              : Effect.void,
          )
          const receiptsExit = yield* Effect.gen(function* () {
            const records = yield* Effect.forEach(
              work.filter((entry) => entry.completion !== null),
              (entry) =>
                Effect.gen(function* () {
                  const completion = entry.completion
                  if (completion === null)
                    return yield* new EntryInferenceError({
                      category: 'INPUT',
                      message: 'Retained completion disappeared',
                    })
                  const receipt = yield* Effect.fromResult(
                    makeJevEvaluationReceipt(entry.request, {
                      schemaVersion: 'bayn.jev-evaluation-receipt.v3',
                      requestId: entry.request.requestId,
                      startedAt: entry.claim.claimedAt,
                      completedAt: completion.completedAt,
                      outcome: { status: JevOutcome.Completed, completion },
                    }),
                  )
                  return { request: entry.request, receipt }
                }),
            )
            if (records.length > 0) yield* (yield* JevEvaluationStore).recordAll(records)
          }).pipe(Effect.exit)
          if (Exit.isFailure(terminalExit) && Exit.isFailure(receiptsExit))
            return yield* Effect.failCause(Cause.combine(terminalExit.cause, receiptsExit.cause))
          if (Exit.isFailure(terminalExit)) return yield* Effect.failCause(terminalExit.cause)
          if (Exit.isFailure(receiptsExit)) return yield* Effect.failCause(receiptsExit.cause)
        })
      }),
    )
  })

const rejectedJevUsage = (error: JevError, expectedRequestHash: string) => {
  if (
    error.requestHash !== expectedRequestHash ||
    error.rejectedResponse === undefined ||
    error.responseHash === undefined
  )
    return null
  const raw = Redacted.value(error.rejectedResponse)
  const hash = canonicalHashV1Result(raw)
  const metering = Schema.decodeUnknownResult(
    Schema.Struct({ model: JevResponseSchema.fields.model, usage: JevResponseSchema.fields.usage }),
  )(raw)
  return Result.isSuccess(hash) && hash.success === error.responseHash && Result.isSuccess(metering)
    ? metering.success.usage
    : null
}

const evaluateHandedOffEntry = (claim: EntryInferenceClaim, handoff: EntryHandoff) =>
  Effect.gen(function* () {
    const expires = Date.parse(claim.expiresAt)
    const omitJev = claim.input.schemaVersion === 'bayn.entry-ablation-input.v1'
    const disposition = handoff.disposition
    const completed = (jev: EntryInferenceCompletion['jev']) =>
      Effect.map(
        Clock.currentTimeMillis,
        (at): EntryInferenceCompletion => ({ handoff, completedAt: utcInstantFromEpochMillis(at), jev }),
      )
    if (disposition.status !== 'READY') return yield* completed({ status: 'NOT_REQUESTED' })
    const jevNow = yield* Clock.currentTimeMillis
    if (jevNow < Date.parse(handoff.recordedAt))
      return yield* new EntryInferenceError({
        category: 'DEADLINE',
        message: 'Entry inference clock regressed after the committed provider handoff',
      })
    if (omitJev) return yield* completed({ status: 'OMITTED_BY_POLICY' })
    if (jevNow >= expires) return yield* completed({ status: 'NOT_DISPATCHED' })
    const client = yield* JevClient
    const inference = yield* client.evaluate(disposition.jevRequest, expires - jevNow).pipe(
      Effect.timeoutOrElse({
        duration: expires - jevNow,
        orElse: () =>
          Effect.fail(
            new EntryInferenceError({
              category: 'DEADLINE',
              message: 'Original evidence window expired during Jev inference',
            }),
          ),
      }),
      Effect.result,
    )
    if (Result.isFailure(inference)) {
      const failure = inference.failure
      return yield* completed({
        status: 'FAILED',
        failure: failure instanceof EntryInferenceError ? JevFailure.Timeout : failure.failure,
        httpStatus: failure instanceof EntryInferenceError ? null : (failure.status ?? null),
        responseHash: failure instanceof EntryInferenceError ? null : (failure.responseHash ?? null),
        usage: failure instanceof EntryInferenceError ? null : rejectedJevUsage(failure, disposition.jevRequestHash),
      })
    }
    const received = inference.success
    const responseHash = canonicalHashV1Result(received.response)
    const returnedAt = yield* Clock.currentTimeMillis
    const bound = received.requestHash === disposition.jevRequestHash
    if (
      !bound ||
      Result.isFailure(responseHash) ||
      responseHash.success !== received.responseHash ||
      Result.isFailure(decodeJevResponse(disposition.jevRequest, received.response)) ||
      Date.parse(received.startedAt) < jevNow ||
      received.completedAt < received.startedAt ||
      Date.parse(received.completedAt) > returnedAt
    )
      return yield* completed({
        status: 'FAILED',
        failure: JevFailure.Response,
        httpStatus: 200,
        responseHash: Result.isSuccess(responseHash) ? responseHash.success : null,
        usage: bound ? received.response.usage : null,
      })
    if (returnedAt >= expires)
      return yield* completed({
        status: 'FAILED',
        failure: JevFailure.Timeout,
        httpStatus: 200,
        responseHash: received.responseHash,
        usage: received.response.usage,
      })
    return yield* completed({ status: 'RECEIVED', inference: received })
  })
