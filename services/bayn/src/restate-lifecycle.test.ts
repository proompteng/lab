import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import {
  beginRestateLifecycleTick,
  completeRestateLifecycleTick,
  decodeLifecycleCommandResponse,
  decodeRestateLifecycleConfig,
  decodeRestateLifecycleTick,
  initialRestateLifecycleState,
  lifecycleCommandFromCursor,
} from './restate-lifecycle'
import { CycleNotDueReason } from './cycle/runner/model'

const configInput = {
  schemaVersion: 'bayn.restate-lifecycle-config.v1',
  controllerKey: 'primary',
  commandBaseUrl: 'http://bayn.bayn.svc.cluster.local:8081',
  operationTimeoutMs: 30_000,
  pollIntervalMs: 30_000,
  sourceRevision: 'a'.repeat(40),
  port: 9080,
} as const

describe('Restate lifecycle domain', () => {
  test('normalizes and binds the exact controller plan', () => {
    const config = Result.getOrThrow(
      decodeRestateLifecycleConfig({ ...configInput, commandBaseUrl: `${configInput.commandBaseUrl}/` }),
    )
    expect(config.commandBaseUrl).toBe(configInput.commandBaseUrl)
    expect(config.planHash).toMatch(/^[0-9a-f]{64}$/)
    expect(config.planHash).toBe(Result.getOrThrow(decodeRestateLifecycleConfig(configInput)).planHash)
    expect(config.planHash).not.toBe(
      Result.getOrThrow(decodeRestateLifecycleConfig({ ...configInput, operationTimeoutMs: 60_000 })).planHash,
    )
  })

  test('accepts every runtime cadence the Restate boundary can receive', () => {
    expect(Result.isSuccess(decodeRestateLifecycleConfig({ ...configInput, operationTimeoutMs: 1_000 }))).toBe(true)
    expect(Result.isSuccess(decodeRestateLifecycleConfig({ ...configInput, operationTimeoutMs: 86_400_000 }))).toBe(
      true,
    )
    expect(Result.isFailure(decodeRestateLifecycleConfig({ ...configInput, operationTimeoutMs: 999 }))).toBe(true)
    expect(Result.isFailure(decodeRestateLifecycleConfig({ ...configInput, operationTimeoutMs: 86_400_001 }))).toBe(
      true,
    )
    expect(Result.isSuccess(decodeRestateLifecycleConfig({ ...configInput, pollIntervalMs: 600_000 }))).toBe(true)
    expect(Result.isSuccess(decodeRestateLifecycleConfig({ ...configInput, pollIntervalMs: 86_400_000 }))).toBe(true)
    expect(Result.isFailure(decodeRestateLifecycleConfig({ ...configInput, pollIntervalMs: 86_400_001 }))).toBe(true)

    const response = {
      schemaVersion: 'bayn.lifecycle-command-response.v1',
      accepted: true,
      commandId: 'c'.repeat(64),
      sequence: 3,
      sourceRevision: configInput.sourceRevision,
      replayed: false,
      observation: {
        result: 'SUCCESS',
        observedAt: '2026-08-10T20:00:00.000Z',
        outcome: 'RECOVERED',
      },
    } as const
    expect(Result.isSuccess(decodeLifecycleCommandResponse({ ...response, nextDelayMs: 1 }))).toBe(true)
    expect(Result.isSuccess(decodeLifecycleCommandResponse({ ...response, nextDelayMs: 86_400_000 }))).toBe(true)
    expect(Result.isFailure(decodeLifecycleCommandResponse({ ...response, nextDelayMs: 0 }))).toBe(true)
    expect(Result.isFailure(decodeLifecycleCommandResponse({ ...response, nextDelayMs: 86_400_001 }))).toBe(true)
  })

  test('decodes legacy ticks and bounded delivery attempts without widening the wire contract', () => {
    const legacyTick = {
      schemaVersion: 'bayn.restate-lifecycle-tick.v1',
      epoch: 5,
      sequence: 2307,
    }
    expect(Result.isSuccess(decodeRestateLifecycleTick(legacyTick))).toBe(true)
    expect(Result.isSuccess(decodeRestateLifecycleTick({ ...legacyTick, deliveryAttempt: 1 }))).toBe(true)
    expect(Result.isFailure(decodeRestateLifecycleTick({ ...legacyTick, deliveryAttempt: -1 }))).toBe(true)
    expect(Result.isFailure(decodeRestateLifecycleTick({ ...legacyTick, deliveryAttempt: 0.5 }))).toBe(true)
    expect(Result.isFailure(decodeRestateLifecycleTick({ ...legacyTick, extra: true }))).toBe(true)
  })

  test('accepts both rolling-deployment v1 bootstrap reasons and normalizes them internally', () => {
    const response = {
      schemaVersion: 'bayn.lifecycle-command-response.v1',
      accepted: true,
      commandId: 'c'.repeat(64),
      sequence: 3,
      sourceRevision: configInput.sourceRevision,
      replayed: false,
      nextDelayMs: 30_000,
      observation: {
        result: 'SUCCESS',
        observedAt: '2026-08-10T20:00:00.000Z',
        outcome: 'NOT_DUE',
        notDueReason: 'STALE_PAPER_BOOTSTRAP',
      },
    } as const

    const legacy = Result.getOrThrow(decodeLifecycleCommandResponse(response))
    const canonical = Result.getOrThrow(
      decodeLifecycleCommandResponse({
        ...response,
        observation: {
          ...response.observation,
          notDueReason: CycleNotDueReason.StaleExecutionBootstrap,
        },
      }),
    )

    expect(legacy.observation).toEqual(canonical.observation)
    expect(legacy.observation).toMatchObject({ notDueReason: CycleNotDueReason.StaleExecutionBootstrap })
  })

  test('rejects credentialed, routed, or non-HTTP command URLs', () => {
    for (const commandBaseUrl of [
      'https://bayn.example.test',
      'http://user:password@bayn:8081',
      'http://bayn:8081/path',
      'http://bayn:8081?target=other',
    ]) {
      expect(Result.isFailure(decodeRestateLifecycleConfig({ ...configInput, commandBaseUrl }))).toBe(true)
    }
  })

  test('recovers the exact started command rather than allocating a duplicate sequence', () => {
    const pending = {
      _tag: 'Pending' as const,
      command: {
        controllerKey: 'primary',
        commandId: 'b'.repeat(64),
        sequence: 7,
        issuedAt: '2026-08-10T20:00:00.000Z',
      },
    }
    expect(lifecycleCommandFromCursor('primary', pending, '2026-08-10T21:00:00.000Z')).toEqual(pending.command)
  })

  test('journals one exact command identity before a response-loss retry', () => {
    const config = Result.getOrThrow(decodeRestateLifecycleConfig(configInput))
    const initial = initialRestateLifecycleState(config, { _tag: 'Next', sequence: 7 }, 4)
    const started = beginRestateLifecycleTick(initial, 'primary', '2026-08-10T20:00:00.000Z')
    const recovered = beginRestateLifecycleTick(started.state, 'primary', '2026-08-10T21:00:00.000Z')

    expect(started.state.cursor).toEqual({ _tag: 'Pending', command: started.command })
    expect(recovered.command).toEqual(started.command)
    expect(recovered.state).toEqual(started.state)
  })

  test('advances a completed command exactly once', () => {
    const config = Result.getOrThrow(decodeRestateLifecycleConfig(configInput))
    const state = initialRestateLifecycleState(config, { _tag: 'Next', sequence: 3 }, 4)
    const completed = completeRestateLifecycleTick(
      state,
      {
        schemaVersion: 'bayn.lifecycle-command-response.v1',
        accepted: true,
        commandId: 'c'.repeat(64),
        sequence: 3,
        sourceRevision: config.sourceRevision,
        replayed: false,
        nextDelayMs: 30_000,
        observation: {
          result: 'SUCCESS',
          observedAt: '2026-08-10T20:00:00.000Z',
          outcome: 'RECOVERED',
        },
      },
      '2026-08-10T20:00:01.000Z',
    )
    expect(completed).toMatchObject({
      active: true,
      epoch: 5,
      cursor: { _tag: 'Next', sequence: 4 },
      lastCompletion: { commandId: 'c'.repeat(64), sequence: 3, result: 'SUCCESS', outcome: 'RECOVERED' },
    })
  })
})
