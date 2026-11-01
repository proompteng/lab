import { JevEvaluationStore, type JevDispatch } from './evaluation'
import { JevOutcome, makeJevEvaluationReceipt, type JevEvaluationRequest } from './evidence'
import { Cause, Clock, Effect, Exit, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import { JevClient, type JevError } from './client'
import { decodeJevResponse, JevFailure, JevResponseSchema } from './contract'
import { DecisionsClient } from './decisions'
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
import { makeSelectedBaseStartStageRequest } from './staged-chart-questions'
import {
  makeStagedDispatchClaim,
  makeStagedSkipReceipt,
  makeStagedTerminalReceipt,
  stageResponseIdentity,
  type BaseStartEvidence,
  type StagedDispatchClaim,
  type StagedSkipReceipt,
  type StagedTerminalReceipt,
} from './staged-checkpoint'

type PreparedEntry = Result.Result.Success<ReturnType<typeof prepareClaimedEntry>>
type BaseRequest = Extract<
  Result.Result.Success<ReturnType<typeof makeSelectedBaseStartStageRequest>>,
  { readonly status: 'PREPARED' }
>
type Work = PreparedEntry & {
  readonly terminals: StagedTerminalReceipt[]
  readonly durableTerminals: Set<string>
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

const visual = (work: Work, claim: StagedDispatchClaim, request: PreparedEntry['visualRequest'] | BaseRequest) =>
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
    const client = yield* DecisionsClient
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
                category: failure.category,
                httpStatus: failure.status ?? null,
                responseHash: failure.requestHash === request.requestHash ? (failure.responseHash ?? null) : null,
                usage: failure.requestHash === request.requestHash ? (failure.usage ?? null) : null,
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
    work.terminals.push(terminal)
    return terminal
  })

const skippedBase = (work: Work, reason: StagedSkipReceipt['reason'], predecessor: StagedTerminalReceipt | null) =>
  Effect.gen(function* () {
    const skip = yield* Effect.fromResult(
      makeStagedSkipReceipt({
        schemaVersion: 'bayn.staged-skip-receipt.v1',
        stage: 'BASE_START',
        requestId: work.claim.requestId,
        reason,
        predecessorHash: predecessor?.terminalHash ?? null,
        recordedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
      }),
    )
    return { status: 'NOT_REQUESTED' as const, skip }
  })

const handoff = (work: Work, terminal: StagedTerminalReceipt | null, baseStart: BaseStartEvidence) =>
  Effect.gen(function* () {
    let disposition: EntryHandoff['disposition']
    if (terminal === null) disposition = { status: 'SOURCE_INFEASIBLE' }
    else if (terminal.outcome.status === 'FAILED')
      disposition = { status: 'VISUAL_FAILED', failure: terminal.outcome.failure }
    else if (baseStart.status === 'FAILED')
      disposition = {
        status: 'PREPARATION_FAILED',
        visual: terminal.outcome.inference,
        reason: 'BASE_START_FAILED',
      }
    else {
      const derived = deriveEntryHandoffDisposition(
        work.prepared.input,
        terminal.outcome.inference,
        baseStart.status === 'RECEIVED' ? baseStart.inference : null,
      )
      disposition = Result.isSuccess(derived)
        ? derived.success
        : {
            status: 'PREPARATION_FAILED',
            visual: terminal.outcome.inference,
            reason: 'DERIVATION_CONTRACT',
          }
    }
    const material = {
      schemaVersion: 'bayn.entry-handoff.v4' as const,
      requestId: work.claim.requestId,
      inputHash: work.prepared.requestHash,
      visualRequestHash: work.visualRequest.requestHash,
      recordedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
      disposition,
      baseStart,
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
        return { ...prepared, request, completion: null, terminals: [], durableTerminals: new Set<string>() }
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
            owner?.durableTerminals.add(transition.terminal.terminalHash)
          }
          if (admissions.find((entry) => entry.requestId === requestId)?.dispatchAllowed !== true)
            return yield* new EntryInferenceError({
              category: 'EXISTING_HANDOFF',
              message: 'An existing stage admission cannot be dispatched again',
            })
        }
      })
    return yield* Effect.gen(function* () {
      const charts = yield* parallel(work, (entry) =>
        Effect.gen(function* () {
          if (entry.visualClaim === null)
            return {
              kind: 'HANDOFF' as const,
              work: entry,
              terminal: null,
              handoff: yield* handoff(entry, null, yield* skippedBase(entry, 'SOURCE_INFEASIBLE', null)),
            }
          const terminal = yield* visual(entry, entry.visualClaim, entry.visualRequest)
          if (terminal.outcome.status === 'FAILED')
            return {
              kind: 'HANDOFF' as const,
              work: entry,
              terminal,
              handoff: yield* handoff(entry, terminal, yield* skippedBase(entry, 'CHART_FAILED', terminal)),
            }
          const request = yield* Effect.fromResult(
            makeSelectedBaseStartStageRequest(
              { chart: entry.chart, protocol: entry.prepared.input.protocol, funding: entry.prepared.input.funding },
              stageResponseIdentity(terminal.outcome.inference),
            ),
          )
          if (request.status === 'NOT_REQUESTED')
            return {
              kind: 'HANDOFF' as const,
              work: entry,
              terminal,
              handoff: yield* handoff(entry, terminal, yield* skippedBase(entry, request.reason, terminal)),
            }
          const admittedAt = yield* Clock.currentTimeMillis
          if (admittedAt >= Date.parse(entry.claim.expiresAt))
            return yield* new EntryInferenceError({
              category: 'DEADLINE',
              message: 'Original evidence window expired before base admission',
            })
          const claim = yield* Effect.fromResult(
            makeStagedDispatchClaim({
              schemaVersion: 'bayn.staged-dispatch-claim.v1',
              stage: 'BASE_START',
              requestId: entry.claim.requestId,
              providerRequestHash: request.requestHash,
              predecessorHash: terminal.terminalHash,
              selectedEnd: request.selectedEnd,
              claimedAt: utcInstantFromEpochMillis(admittedAt),
              expiresAt: entry.claim.expiresAt,
            }),
          )
          return { kind: 'BASE_START' as const, work: entry, terminal, request, claim }
        }),
      )
      yield* commit(
        charts.map(
          (entry): EntryStageTransition =>
            entry.kind === 'BASE_START'
              ? { terminal: entry.terminal, successor: { kind: 'VISUAL', claim: entry.claim } }
              : { terminal: entry.terminal, successor: { kind: 'HANDOFF', handoff: entry.handoff } },
        ),
      )
      const complete = (entry: Work, committed: EntryHandoff) =>
        Effect.gen(function* () {
          const completion = yield* evaluateHandedOffEntry(entry.claim, committed)
          entry.completion = completion
          return completion
        })
      // A ready handoff from the first commit need not wait for an unrelated
      // candidate's base provider and second commit. These disjoint groups keep
      // total provider concurrency bounded by the admitted candidate count.
      // Settle both groups before failure cleanup so every paid response survives.
      yield* parallel(
        [
          parallel(
            charts.filter((entry) => entry.kind === 'HANDOFF'),
            (entry) => complete(entry.work, entry.handoff),
          ),
          Effect.gen(function* () {
            const bases = yield* parallel(
              charts.filter((entry) => entry.kind === 'BASE_START'),
              (entry) =>
                Effect.gen(function* () {
                  const terminal = yield* visual(entry.work, entry.claim, entry.request)
                  return {
                    work: entry.work,
                    terminal,
                    handoff: yield* handoff(entry.work, entry.terminal, terminal.outcome),
                  }
                }),
            )
            yield* commit(
              bases.map((entry) => ({
                terminal: entry.terminal,
                successor: { kind: 'HANDOFF' as const, handoff: entry.handoff },
              })),
            )
            return yield* parallel(bases, (entry) => complete(entry.work, entry.handoff))
          }),
        ],
        (group) => group,
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
          entry.terminals.filter((terminal) => !entry.durableTerminals.has(terminal.terminalHash)),
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
