import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { matchedCommittedDecisionFixture } from '../../intraday-replay/matched-entry.test-support'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../../jev/native.test-support'
import { CycleState, CycleTerminalReason, type AutonomousCycle } from '../model'
import {
  decideAcquire,
  decideActivation,
  decideBlock,
  decideCompletion,
  decideDecisionBinding,
  makeInitialCycle,
  validateBlockedDecision,
  validateCompletionDocument,
} from './decisions'

const native = nativeJevFixture()
const document = await Effect.runPromise(matchedCommittedDecisionFixture(native, nativeJevDecisionEvidence(native)))
const at = document.createdAt
const pending = () => makeInitialCycle(native.draft, native.observation.payload.observedAt)
const active = (): AutonomousCycle => ({ ...pending(), state: CycleState.Active, updatedAt: at })
const bound = (): AutonomousCycle => ({
  ...active(),
  bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
  stateVersion: 3,
})
const value = Result.getOrThrow

describe('current cycle store decisions', () => {
  test('acquires a deterministic current cycle and rejects a different authority binding', () => {
    const initial = pending()
    expect(value(decideAcquire(initial, native.draft, true))).toEqual({ cycle: initial, created: true })
    expect(
      Result.isFailure(
        decideAcquire(
          initial,
          { ...native.draft, identity: { ...native.draft.identity, accountId: 'foreign' } },
          false,
        ),
      ),
    ).toBe(true)
  })

  test('activates an unbound cycle, replays activation, and blocks at the submission deadline', () => {
    expect(value(decideActivation(pending(), at))._tag).toBe('Persist')
    expect(value(decideActivation(active(), at))._tag).toBe('Replay')
    expect(value(decideActivation(bound(), native.draft.window.submissionCutoffAt))._tag).toBe('Replay')
    expect(value(decideActivation(pending(), native.draft.window.submissionCutoffAt))).toMatchObject({ _tag: 'Block' })
    expect(Result.isFailure(decideActivation({ ...bound(), state: CycleState.NoTrade, terminalAt: at }, at))).toBe(true)
  })

  test('binds the snapshot with the exact durable decision and only replays the same evidence', () => {
    expect(value(decideDecisionBinding(active(), document, at, []))).toEqual({
      _tag: 'Persist',
      cycle: active(),
      document,
    })
    expect(value(decideDecisionBinding(bound(), document, at, [document]))._tag).toBe('Replay')
    expect(Result.isFailure(decideDecisionBinding(bound(), document, at, []))).toBe(true)
    expect(
      Result.isFailure(
        decideDecisionBinding(
          active(),
          { ...document, bindings: { ...document.bindings, accountId: 'foreign' } },
          at,
          [],
        ),
      ),
    ).toBe(true)
    expect(value(decideDecisionBinding(active(), document, native.draft.window.submissionCutoffAt, []))._tag).toBe(
      'Block',
    )
  })

  test('requires the exact bound decision for no-trade completion', () => {
    const decision = value(decideCompletion(bound(), CycleState.NoTrade, at))
    expect(decision._tag).toBe('VerifyDecision')
    if (decision._tag !== 'VerifyDecision') return expect.unreachable()
    expect(value(validateCompletionDocument(decision, [document], true))).toBeUndefined()
    expect(Result.isFailure(validateCompletionDocument(decision, [], true))).toBe(true)
  })

  test('preserves authority blocks and cannot turn a no-trade receipt into another blocked reason', () => {
    expect(value(decideBlock(active(), CycleTerminalReason.Authority, at))).toMatchObject({
      _tag: 'Persist',
      reason: CycleTerminalReason.Authority,
    })
    expect(Result.isFailure(decideBlock(active(), CycleTerminalReason.MissedSubmission, at))).toBe(true)
    const decision = value(decideBlock(bound(), CycleTerminalReason.DataStale, at))
    expect(decision._tag).toBe('VerifyDecision')
    if (decision._tag !== 'VerifyDecision') return expect.unreachable()
    expect(Result.isFailure(validateBlockedDecision(decision, [document]))).toBe(true)
  })
})
