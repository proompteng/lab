import { describe, expect, test } from 'bun:test'

import { decideLifecycleCommand, lifecycleCommandId } from './lifecycle-command-contract'

describe('Bayn lifecycle command contract', () => {
  const sourceRevision = 'a'.repeat(40)
  const command = {
    schemaVersion: 'bayn.lifecycle-command.v1' as const,
    controllerKey: 'primary',
    commandId: lifecycleCommandId('primary', 7),
    sequence: 7,
    issuedAt: '2026-08-10T12:00:00.000Z',
    sourceRevision,
  }

  test('accepts only the exact deterministic controller command identity', () => {
    expect(decideLifecycleCommand('primary', [sourceRevision], command)).toEqual({
      _tag: 'Accept',
      sourceRevision,
      command: {
        controllerKey: command.controllerKey,
        commandId: command.commandId,
        sequence: command.sequence,
        issuedAt: command.issuedAt,
      },
    })
    expect(decideLifecycleCommand('other', [sourceRevision], command)).toEqual({
      _tag: 'Reject',
      status: 403,
      reason: 'CONTROLLER_MISMATCH',
    })
    expect(decideLifecycleCommand('primary', [sourceRevision], { ...command, commandId: '0'.repeat(64) })).toEqual({
      _tag: 'Reject',
      status: 403,
      reason: 'CONTROLLER_MISMATCH',
    })
    expect(decideLifecycleCommand('primary', ['b'.repeat(40)], command)).toEqual({
      _tag: 'Reject',
      status: 503,
      reason: 'SOURCE_REVISION_MISMATCH',
    })
  })

  test('rejects malformed and unbounded command input without coercion', () => {
    expect(decideLifecycleCommand('primary', [sourceRevision], { ...command, sequence: 0 })).toEqual({
      _tag: 'Reject',
      status: 400,
      reason: 'INVALID_COMMAND',
    })
    expect(decideLifecycleCommand('primary', [sourceRevision], { ...command, extra: true })).toEqual({
      _tag: 'Reject',
      status: 400,
      reason: 'INVALID_COMMAND',
    })
  })
})
