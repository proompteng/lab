import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { parseForwardPerformanceCommandArgs } from './forward-performance-command'

describe('forward-performance command arguments', () => {
  test('allows an exact authority generation without widening to account history', () => {
    const authorityGenerationHash = 'a'.repeat(64)
    const result = parseForwardPerformanceCommandArgs(['--authority-generation', authorityGenerationHash])
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual({ _tag: 'Run', options: { authorityGenerationHash } })
    }
  })

  test('preserves explicit help and the existing account-history invocation', () => {
    expect(Result.getOrThrow(parseForwardPerformanceCommandArgs(['--help']))).toEqual({ _tag: 'Help' })
    expect(Result.getOrThrow(parseForwardPerformanceCommandArgs([]))).toEqual({ _tag: 'Run', options: {} })
  })

  test('the command rejects a malformed generation before loading runtime configuration', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, `${import.meta.dir}/forward-performance-command.ts`, '--authority-generation', 'invalid'],
      env: { BAYN_OPERATION: 'invalid' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toContain(
      'ForwardPerformanceCommandArgumentError',
    )
  })

  const invalidArguments = [
    ['--authority-generation'],
    ['--authority-generation', ''],
    ['--authority-generation', 'a'.repeat(63)],
    ['--authority-generation', 'z'.repeat(64)],
    ['--authority-generation', 'a'.repeat(64), '--authority-generation', 'b'.repeat(64)],
    ['--authority-generation', 'a'.repeat(64), '--help'],
    ['--help', 'unexpected'],
    ['--unknown'],
  ]
  for (const args of invalidArguments) {
    test(`rejects invalid or ambiguous arguments before any evidence reads: ${JSON.stringify(args)}`, () => {
      expect(Result.isFailure(parseForwardPerformanceCommandArgs(args))).toBe(true)
    })
  }
})
