import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Result, Schema } from 'effect'

import { MutationOperation } from '../../src/broker/alpaca-mutations/model'
import { AutonomousCycleSchema, CycleState } from '../../src/cycle/model'
import { DecisionReadinessReason } from '../../src/cycle/runner/readiness'
import { Authority, KillState } from '../../src/execution/contracts'
import { completeExecutionControllerTick, decideExecutionControllerTick } from '../../src/execution/controller'
import { ExecutionControllerOutcome } from '../../src/execution/controller-status'
import {
  allowsOutcomeEvent,
  decideMutationAuthority,
  decideMutationStartReplay,
  mutationIdResult,
} from '../../src/execution/mutations/decisions'
import { MutationEventType, type MutationEvent } from '../../src/execution/mutations/model'
import { nativeJevFixture } from '../../src/jev/native.test-support'
import { preflightTransfers, verifyExactTransfers } from '../../src/ledger-plan/verification'
import type { LedgerTransferRecord } from '../../src/ledger-plan/model'
import { decisionReadinessContinuationDelayMs } from '../../src/observe-composition/recovery-driver'
import { strictParseOptions } from '../../src/schemas'

const directory = process.env['BAYN_TLA_STATE_DIRECTORY']
const states = (model: string): readonly unknown[] => {
  if (directory === undefined) throw Error('Run verify:tla to produce the checked state space')
  const text = readFileSync(join(directory, model, `${model}.dump`), 'utf8')
  const blocks = text.split(/^State \d+:\s*$/m)
  if (blocks[0]?.trim() !== '' || blocks.length < 2) throw Error(`Missing TLC states for ${model}`)
  return blocks.slice(1).map((block) => {
    const field = /(\w+) \|-> (TRUE|FALSE|-?\d+|"[^"\\]*")/g
    const entries = [...block.matchAll(field)].map((match) => {
      const [, key, value] = match
      if (key === undefined || value === undefined) throw Error('Invalid TLC record field')
      const decoded: unknown = value === 'TRUE' ? true : value === 'FALSE' ? false : JSON.parse(value)
      return [key, decoded] as const
    })
    if (block.replace(field, '').replace(/[\s,[\]]/g, '') !== '' || entries.length === 0)
      throw Error(`Unsupported TLC state encoding in ${model}`)
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw Error('Duplicate TLC record fields')
    return Object.fromEntries(entries)
  })
}
const bool = Schema.Boolean
const int = Schema.Int
const ControllerState = Schema.Struct({
  active: bool,
  epoch: int,
  source: int,
  sequence: int,
  deliveryEpoch: int,
  deliverySource: int,
  deliverySequence: int,
  inFlight: bool,
  proposalEpoch: int,
  proposalSource: int,
  proposalSequence: int,
  staleCommit: bool,
  canAdvance: bool,
  canComplete: bool,
})
const EntryState = Schema.Struct({
  now: int,
  state: Schema.Enum(CycleState),
  snapshotBound: bool,
  decisionBound: bool,
  mode: Schema.Literals(['INITIAL', 'LATER', 'CONSUMED', 'SOURCE_UNAVAILABLE']),
  inputReady: bool,
  wake: int,
  lastDelay: int,
  scheduled: bool,
  lastShort: bool,
  decisionAt: int,
  sawInput: bool,
  continuationDelay: int,
  deadline: int,
  normalDelay: int,
  retryDelay: int,
})
const MutationState = Schema.Struct({
  operation: Schema.Enum(MutationOperation),
  closeOnly: bool,
  maximum: bool,
  effective: bool,
  killed: bool,
  generationExecution: bool,
  accountBound: bool,
  phase: Schema.Union([Schema.Literal('NONE'), Schema.Enum(MutationEventType)]),
  starts: int,
  authorizedStart: bool,
  filled: bool,
  postedA: int,
  postedB: int,
  corrupt: bool,
  duplicate: bool,
  accounted: bool,
  worker: int,
  pendingA1: bool,
  pendingA2: bool,
  pendingB1: bool,
  pendingB2: bool,
  authorityAllowed: bool,
  mayStart: bool,
  preflightValid: bool,
  missingA: bool,
  missingB: bool,
  exact: bool,
  submitAccepted: bool,
  submitRejected: bool,
  submitDenied: bool,
  submitUnknown: bool,
  cancelAccepted: bool,
  cancelUnknown: bool,
  recoveryFound: bool,
  recoveryNotFound: bool,
  recoveryUnknown: bool,
})
const hash = 'a'.repeat(64)
const revision = (source: number) => String(source).repeat(40)
const at = (seconds: number) => new Date(Date.parse('2026-09-04T14:31:02.000Z') + seconds * 1_000).toISOString()

describe.skipIf(directory === undefined)('TLC reachable states conform to production', () => {
  test('controller delivery and completion guards reject stale epochs, sequences and worker sources', () => {
    const cases = Schema.decodeUnknownSync(Schema.Array(ControllerState), strictParseOptions)(states('Controller'))
    expect(cases.some((s) => s.canAdvance)).toBe(true)
    expect(cases.some((s) => s.inFlight && !s.canComplete)).toBe(true)
    expect(cases.some((s) => !s.active)).toBe(true)
    expect(cases.some((s) => s.epoch === 2 && s.sequence === 2)).toBe(true)
    for (const s of cases) {
      const state = {
        schemaVersion: 1,
        active: s.active,
        epoch: s.epoch,
        sourceRevision: revision(s.source),
        planHash: hash,
        initialSequence: 0,
        nextSequence: s.sequence,
      } as const
      const tick = {
        schemaVersion: 'bayn.execution-controller-tick.v1',
        epoch: s.deliveryEpoch,
        sequence: s.deliverySequence,
      } as const
      const advance = decideExecutionControllerTick(state, tick, hash, revision(s.deliverySource))
      expect(Result.isSuccess(advance) && advance.success._tag === 'Advance').toBe(s.canAdvance)
      const complete = completeExecutionControllerTick(
        state,
        {
          ...tick,
          epoch: s.proposalEpoch,
          sequence: s.proposalSequence,
        },
        {
          completedAt: at(1),
          outcome: { _tag: ExecutionControllerOutcome.Completed, receiptHash: hash, nextDelayMs: 1_000 },
        },
        revision(s.proposalSource),
      )
      expect(Result.isSuccess(complete)).toBe(s.canComplete)
      if (Result.isSuccess(complete)) {
        expect(complete.success.nextSequence).toBe(s.sequence + 1)
        expect(complete.success.epoch).toBe(s.epoch)
        expect(complete.success.sourceRevision).toBe(revision(s.source))
        expect(complete.success.nextDueAt).toBe(at(2))
      }
    }
  })

  test('initial and later input retries retain the original admission, binding and consumed-window guards', () => {
    const cases = Schema.decodeUnknownSync(Schema.Array(EntryState), strictParseOptions)(states('EntryRecovery'))
    const native = nativeJevFixture()
    const base = Schema.decodeUnknownSync(
      AutonomousCycleSchema,
      strictParseOptions,
    )({
      ...native.draft,
      state: CycleState.Active,
      bindings: {},
      stateVersion: 1,
      createdAt: at(0),
      updatedAt: at(0),
    })
    expect(new Set(cases.map((s) => s.mode)).size).toBe(4)
    expect(cases.some((s) => s.state === CycleState.Completed && s.sawInput)).toBe(true)
    expect(cases.some((s) => s.state === CycleState.Blocked && !s.sawInput)).toBe(true)
    expect(cases.some((s) => s.continuationDelay > 0)).toBe(true)
    expect(cases.some((s) => s.now === s.deadline && s.continuationDelay === 0)).toBe(true)
    for (const s of cases) {
      const actual = decisionReadinessContinuationDelayMs(
        {
          outcome: 'RECOVERED',
          action: 'WAITING',
          observedAt: at(s.now),
          cycle: {
            ...base,
            state: s.state,
            window: { ...base.window, submissionOpenAt: at(0), submissionCutoffAt: at(s.deadline) },
            bindings: {
              ...(s.snapshotBound ? { snapshotId: hash } : {}),
              ...(s.decisionBound ? { decisionHash: hash } : {}),
            },
          },
          readiness: {
            reason: DecisionReadinessReason.SnapshotUnavailable,
            message: 'Captured pending input query',
            ...(s.mode === 'SOURCE_UNAVAILABLE'
              ? {}
              : {
                  snapshotQuery: {
                    rangeStartAt: at(-60),
                    rangeEndAt: at(0),
                    symbols: ['AAPL'],
                    ...(s.mode === 'INITIAL' ? {} : { previousWindowEndAt: at(s.mode === 'LATER' ? -60 : 0) }),
                  },
                }),
          },
        },
        s.normalDelay * 1_000,
        at(s.now),
      )
      expect(actual ?? 0).toBe(s.continuationDelay * 1_000)
    }
  })

  test('mutation authority, immutable start replay and every reachable outcome agree with production', () => {
    const cases = Schema.decodeUnknownSync(Schema.Array(MutationState), strictParseOptions)(states('MutationLedger'))
    expect(cases.some((s) => s.phase === MutationEventType.SubmitUnknown && !s.mayStart)).toBe(true)
    expect(cases.some((s) => s.killed && s.closeOnly && s.authorityAllowed)).toBe(true)
    expect(cases.some((s) => !s.authorityAllowed)).toBe(true)
    expect(cases.some((s) => s.worker === 2 && s.starts === 1)).toBe(true)
    for (const s of cases) {
      const authority = decideMutationAuthority(
        s.operation,
        {
          maximum: s.maximum ? Authority.Execution : Authority.Observe,
          effective: s.effective ? Authority.Execution : Authority.Observe,
          killState: s.killed ? KillState.Active : KillState.Clear,
          generationHash: hash,
          generationMaximum: s.generationExecution ? Authority.Execution : Authority.Observe,
          generationAccountId: s.accountBound ? 'account' : null,
        },
        s.closeOnly,
      )
      expect(Result.isSuccess(authority)).toBe(s.authorityAllowed)
      const input = { intentId: hash, requestHash: hash, consistencyDelayMs: 1_000, occurredAt: at(0) }
      const existing: MutationEvent | undefined =
        s.phase === 'NONE'
          ? undefined
          : {
              schemaVersion: 'bayn.paper-mutation-event.v1',
              eventId: hash,
              mutationId: Result.getOrThrow(mutationIdResult(hash, s.operation)),
              intentId: hash,
              sequence: 1,
              operation: s.operation,
              eventType: s.phase,
              requestHash: hash,
              consistencyDelayMs: 1_000,
              occurredAt: at(0),
            }
      const replay = decideMutationStartReplay(s.operation, input, existing)
      expect(Result.isSuccess(authority) && Result.isSuccess(replay) && replay.success._tag === 'BeginMutation').toBe(
        s.mayStart,
      )
      if (existing !== undefined) {
        expect(
          Result.isFailure(decideMutationStartReplay(s.operation, { ...input, requestHash: 'b'.repeat(64) }, existing)),
        ).toBe(true)
      }
      for (const [key, event] of [
        ['submitAccepted', MutationEventType.SubmitAccepted],
        ['submitRejected', MutationEventType.SubmitRejected],
        ['submitDenied', MutationEventType.SubmitDenied],
        ['submitUnknown', MutationEventType.SubmitUnknown],
        ['cancelAccepted', MutationEventType.CancelAccepted],
        ['cancelUnknown', MutationEventType.CancelUnknown],
        ['recoveryFound', MutationEventType.RecoveryFound],
        ['recoveryNotFound', MutationEventType.RecoveryNotFound],
        ['recoveryUnknown', MutationEventType.RecoveryUnknown],
      ] as const) {
        expect(s.phase !== 'NONE' && allowsOutcomeEvent(s.phase, event)).toBe(s[key])
      }
      if (s.phase !== 'NONE') {
        expect(allowsOutcomeEvent(s.phase, MutationEventType.SubmitStarted)).toBe(false)
        expect(allowsOutcomeEvent(s.phase, MutationEventType.CancelStarted)).toBe(false)
      }
    }
  })

  test('every reachable partial ledger posting uses production preflight and exact metadata verification', () => {
    const cases = Schema.decodeUnknownSync(Schema.Array(MutationState), strictParseOptions)(states('MutationLedger'))
    const transfer = (id: bigint): LedgerTransferRecord => ({
      id,
      debit_account_id: 10n,
      credit_account_id: 20n,
      amount: 1_000_000n,
      pending_id: 0n,
      user_data_128: 30n,
      user_data_64: 40n,
      user_data_32: 50,
      timeout: 0,
      ledger: 7_002,
      code: 1,
      flags: 0,
      timestamp: 0n,
    })
    const expected = [transfer(1n), transfer(2n)]
    expect(cases.some((s) => s.postedA === 1 && s.postedB === 0)).toBe(true)
    expect(cases.some((s) => s.postedA === 0 && s.postedB === 1)).toBe(true)
    expect(cases.some((s) => s.pendingA1 && s.pendingA2 && s.postedA === 0)).toBe(true)
    expect(cases.some((s) => s.postedA === 1 && (s.pendingA1 || s.pendingA2))).toBe(true)
    expect(cases.some((s) => s.accounted && s.exact)).toBe(true)
    expect(cases.some((s) => s.corrupt && !s.preflightValid)).toBe(true)
    expect(cases.some((s) => s.duplicate && !s.preflightValid)).toBe(true)
    for (const s of cases) {
      const existing = expected
        .filter((t) => (t.id === 1n ? s.postedA === 1 : s.postedB === 1))
        .map((t) => (s.corrupt ? { ...t, amount: t.amount + 1n } : t))
      if (s.duplicate) {
        const first = existing[0]
        if (first === undefined) throw Error('Invalid duplicate-posting state')
        existing.push(first)
      }
      const preflight = preflightTransfers(expected, existing)
      expect(Result.isSuccess(preflight)).toBe(s.preflightValid)
      expect(Result.isSuccess(preflight) && preflight.success.some((t) => t.id === 1n)).toBe(s.missingA)
      expect(Result.isSuccess(preflight) && preflight.success.some((t) => t.id === 2n)).toBe(s.missingB)
      expect(
        Result.isSuccess(verifyExactTransfers('verify-existing-transfers', 'TLC replay', existing, expected)),
      ).toBe(s.exact)
    }
  })
})
