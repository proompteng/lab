import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { parseForwardPerformanceCommandArgs } from './forward-performance-command'

describe('forward-performance command arguments', () => {
  test('supports prospective registration, immutable source capture, assessment, and a scoped report receipt', () => {
    for (const [flag, tag] of [
      ['--system-history', 'SystemHistory'],
      ['--system-register', 'SystemRegister'],
      ['--system-assess', 'SystemAssess'],
      ['--system-capture-replay', 'SystemCaptureReplay'],
    ] as const)
      expect(Result.getOrThrow(parseForwardPerformanceCommandArgs([flag ?? '', '/private/evidence.json']))).toEqual({
        _tag: tag,
        path: '/private/evidence.json',
      })
    expect(Result.getOrThrow(parseForwardPerformanceCommandArgs(['--system-capture', 'a'.repeat(64)]))).toEqual({
      _tag: 'SystemCapture',
      registrationHash: 'a'.repeat(64),
    })
    expect(
      Result.getOrThrow(
        parseForwardPerformanceCommandArgs(['--authority-generation', 'a'.repeat(64), '--assessment', 'b'.repeat(64)]),
      ),
    ).toEqual({ _tag: 'Run', options: { authorityGenerationHash: 'a'.repeat(64), assessmentHash: 'b'.repeat(64) } })
    expect(Result.isFailure(parseForwardPerformanceCommandArgs(['--system-capture', 'latest']))).toBe(true)
  })
  test('allows an exact authority generation without widening to account history', () => {
    const authorityGenerationHash = 'a'.repeat(64)
    const result = parseForwardPerformanceCommandArgs(['--authority-generation', authorityGenerationHash])
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual({ _tag: 'Run', options: { authorityGenerationHash } })
    }
  })

  test('requires explicit persistence opt-in alongside an exact authority generation', () => {
    const authorityGenerationHash = 'a'.repeat(64)
    expect(
      Result.getOrThrow(
        parseForwardPerformanceCommandArgs(['--authority-generation', authorityGenerationHash, '--persist-receipt']),
      ),
    ).toEqual({ _tag: 'Run', options: { authorityGenerationHash, persistReceipt: true } })
    expect(Result.isFailure(parseForwardPerformanceCommandArgs(['--persist-receipt']))).toBe(true)
  })

  test('preserves explicit help and rejects an unbounded account-history invocation', () => {
    expect(Result.getOrThrow(parseForwardPerformanceCommandArgs(['--help']))).toEqual({ _tag: 'Help' })
    expect(Result.isFailure(parseForwardPerformanceCommandArgs([]))).toBe(true)
  })

  test('accepts an explicit aggregate deadline only for an exact read-only report', () => {
    for (const deadlineMs of [1, 30_000, 2_147_483_647]) {
      expect(
        Result.getOrThrow(
          parseForwardPerformanceCommandArgs([
            '--authority-generation',
            'a'.repeat(64),
            '--deadline-ms',
            `${deadlineMs}`,
          ]),
        ),
      ).toEqual({ _tag: 'Supervised', deadlineMs, options: { authorityGenerationHash: 'a'.repeat(64) } })
    }
    expect(
      Result.getOrThrow(
        parseForwardPerformanceCommandArgs([
          '--authority-generation',
          'a'.repeat(64),
          '--assessment',
          'b'.repeat(64),
          '--deadline-ms',
          '30000',
        ]),
      ),
    ).toEqual({
      _tag: 'Supervised',
      deadlineMs: 30_000,
      options: { authorityGenerationHash: 'a'.repeat(64), assessmentHash: 'b'.repeat(64) },
    })
  })

  test('rejects deadline persistence and system operations before configuration or evidence access', () => {
    for (const args of [
      ['--authority-generation', 'a'.repeat(64), '--persist-receipt', '--deadline-ms', '30000'],
      ['--system-capture-replay', '/must-not-read/evidence.json', '--deadline-ms', '30000'],
    ]) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, `${import.meta.dir}/forward-performance-command.ts`, ...args],
        env: { BAYN_OPERATION: 'invalid' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(1)
      expect(result.stdout.length).toBe(0)
      expect(new TextDecoder().decode(result.stderr)).toContain('ForwardPerformanceCommandArgumentError')
      expect(new TextDecoder().decode(result.stderr)).not.toContain('ForwardPerformanceWorkerFailed')
    }
  })

  test('a supervised worker configuration failure emits no captured report stdout', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        `${import.meta.dir}/forward-performance-command.ts`,
        '--authority-generation',
        'a'.repeat(64),
        '--deadline-ms',
        '10000',
      ],
      env: { BAYN_OPERATION: 'invalid' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout.length).toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toContain('ForwardPerformanceWorkerFailed')
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
    ...['0', '-1', '1.5', '1e3', '01', '+1', ' 1', '1 ', 'NaN', 'Infinity', '2147483648', '9007199254740993'].map(
      (deadline) => ['--authority-generation', 'a'.repeat(64), '--deadline-ms', deadline],
    ),
    ['--authority-generation', 'a'.repeat(64), '--deadline-ms'],
    ['--authority-generation', 'a'.repeat(64), '--deadline-ms', '100', '--deadline-ms', '200'],
    ['--authority-generation', 'a'.repeat(64), '--deadline-ms', '100', '--assessment', 'b'.repeat(64)],
    ['--authority-generation', 'a'.repeat(64), '--deadline-ms', '100', '--persist-receipt'],
    [
      '--authority-generation',
      'a'.repeat(64),
      '--assessment',
      'b'.repeat(64),
      '--persist-receipt',
      '--deadline-ms',
      '100',
    ],
    ['--help', '--deadline-ms', '100'],
    ...['--system-history', '--system-register', '--system-capture', '--system-capture-replay', '--system-assess'].map(
      (flag) => [flag, 'a'.repeat(64), '--deadline-ms', '100'],
    ),
  ]
  for (const args of invalidArguments) {
    test(`rejects invalid or ambiguous arguments before any evidence reads: ${JSON.stringify(args)}`, () => {
      expect(Result.isFailure(parseForwardPerformanceCommandArgs(args))).toBe(true)
    })
  }
})
