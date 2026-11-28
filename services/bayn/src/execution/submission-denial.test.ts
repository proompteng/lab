import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { invalidRequest, MutationOperation } from '../broker/alpaca-mutations/model'
import { canonicalHashV1Result } from '../hash'
import { decideSubmitFailure } from './coordinator-decisions'
import { IntentState, TerminalOutcome } from './contracts'
import { decodeOutcomeInput, decideMutationOutcome, makeEventResult, mutationIdResult } from './mutations/decisions'
import { MutationEventType, OutcomeInputSchema } from './mutations/model'
import { SubmissionDenialReason, SubmissionDenialReasonSchema, submissionDenialReason } from './submission-denial'

const intentId = Result.getOrThrow(canonicalHashV1Result({ fixture: 'denial-intent' }))
const requestHash = Result.getOrThrow(canonicalHashV1Result({ fixture: 'denial-request' }))
const startedAt = '2026-10-13T14:00:00.000Z'
const occurredAt = '2026-10-13T14:00:01.000Z'
const started = Result.getOrThrow(
  makeEventResult('begin-submit', {
    mutationId: Result.getOrThrow(mutationIdResult(intentId, MutationOperation.Submit)),
    intentId,
    sequence: 1,
    operation: MutationOperation.Submit,
    eventType: MutationEventType.SubmitStarted,
    requestHash,
    consistencyDelayMs: 1000,
    occurredAt: startedAt,
  }),
)

describe('durable submission denial reasons', () => {
  test('the database outcome decoder preserves the typed denial reason', () => {
    const input = { intentId, requestHash, occurredAt, denialReason: SubmissionDenialReason.ExpiredRiskDecision }
    expect(Result.getOrThrow(decodeOutcomeInput('record-submit', input))).toEqual(input)
  })

  test.each([
    [{ _tag: 'ExpiredRiskDecision', expiresAt: startedAt }, SubmissionDenialReason.ExpiredRiskDecision],
    [{ _tag: 'ExecutionWindowExpired' }, SubmissionDenialReason.ExecutionWindowExpired],
    [{ _tag: 'BrokerStateStale' }, SubmissionDenialReason.BrokerStateStale],
    [{ _tag: 'BrokerStateCacheUnavailable', reason: 'stale' }, SubmissionDenialReason.BrokerStateStale],
    [{ _tag: 'BrokerStateCacheUnavailable', reason: 'consumed' }, SubmissionDenialReason.BrokerStateConsumed],
    [{ _tag: 'IntentAuthorityGenerationMismatch' }, SubmissionDenialReason.IntentAuthorityGenerationMismatch],
    [{ _tag: 'InstrumentError', symbol: 'AAPL' }, SubmissionDenialReason.InstrumentError],
    [{ _tag: 'IntentAccountMismatch', expected: 'private-account' }, SubmissionDenialReason.AccountMismatch],
  ] as const)('retains the bounded reason for %j', (cause, expected) => {
    const failure = invalidRequest({ operation: MutationOperation.Submit, message: 'private diagnostic', cause })
    expect(decideSubmitFailure(requestHash, failure)).toEqual({ _tag: 'SubmitDenied', denialReason: expected })
  })

  test('does not promote unknown tags or exception messages into durable evidence', () => {
    for (const cause of [
      undefined,
      null,
      'ExpiredRiskDecision',
      { _tag: 'secret-value', message: 'private' },
      new Error('ExpiredRiskDecision'),
    ]) {
      expect(submissionDenialReason(cause)).toBe(SubmissionDenialReason.Unclassified)
    }
    expect(Schema.is(SubmissionDenialReasonSchema)('secret-value')).toBe(false)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(OutcomeInputSchema)({
          intentId,
          requestHash,
          occurredAt,
          denialReason: 'secret-value',
        }),
      ),
    ).toBe(true)
  })

  test('binds a new denial reason into identity and rejects conflicting or omitted replay evidence', () => {
    const input = { intentId, requestHash, occurredAt, denialReason: SubmissionDenialReason.ExpiredRiskDecision }
    const definition = { _tag: 'SubmitDenied' } as const
    const recorded = Result.getOrThrow(
      decideMutationOutcome(input, definition, started, { state: IntentState.IoStarted, terminalOutcome: null }),
    )
    expect(recorded._tag).toBe('AppendMutation')
    expect(recorded.event.denialReason).toBe(SubmissionDenialReason.ExpiredRiskDecision)
    const { eventId, ...material } = recorded.event
    expect(eventId).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
    const terminal = { state: IntentState.Terminal, terminalOutcome: TerminalOutcome.Rejected }
    expect(Result.getOrThrow(decideMutationOutcome(input, definition, recorded.event, terminal))).toEqual({
      _tag: 'ReplayMutation',
      event: recorded.event,
    })
    for (const changed of [
      { ...input, denialReason: SubmissionDenialReason.ExecutionWindowExpired },
      { intentId, requestHash, occurredAt },
    ]) {
      expect(Result.isFailure(decideMutationOutcome(changed, definition, recorded.event, terminal))).toBe(true)
    }
  })

  test('preserves historical reasonless event identity and replay', () => {
    const input = { intentId, requestHash, occurredAt }
    const definition = { _tag: 'SubmitDenied' } as const
    const old = Result.getOrThrow(
      decideMutationOutcome(input, definition, started, { state: IntentState.IoStarted, terminalOutcome: null }),
    ).event
    expect(old).not.toHaveProperty('denialReason')
    const { eventId, ...material } = old
    expect(eventId).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
    expect(
      Result.getOrThrow(
        decideMutationOutcome(input, definition, old, {
          state: IntentState.Terminal,
          terminalOutcome: TerminalOutcome.Rejected,
        }),
      ),
    ).toEqual({ _tag: 'ReplayMutation', event: old })
  })

  test('cannot attach a local-denial reason to a broker acknowledgement or unknown outcome', () => {
    for (const definition of [{ _tag: 'SubmitAccepted' }, { _tag: 'SubmitUnknown' }] as const) {
      const result = decideMutationOutcome(
        {
          intentId,
          requestHash,
          occurredAt,
          denialReason: SubmissionDenialReason.ExpiredRiskDecision,
          brokerOrderId: 'broker-order',
          evidence: { requestId: 'request', status: 200, contentHash: requestHash, observedAt: occurredAt },
        },
        definition,
        started,
        { state: IntentState.IoStarted, terminalOutcome: null },
      )
      expect(Result.isFailure(result)).toBe(true)
    }
  })
})
