import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { INTRADAY_REPLAY_COMMAND_USAGE, parseIntradayReplayCommandArgs } from './intraday-replay-command'

describe('intraday replay command', () => {
  test('requires an explicit input file and preserves its path', () => {
    expect(Result.getOrThrow(parseIntradayReplayCommandArgs(['--input', '/tmp/replay input.json']))).toEqual({
      _tag: 'Run',
      inputPath: '/tmp/replay input.json',
    })
  })

  for (const args of [
    [],
    ['--input'],
    ['--input', ''],
    ['--input', '  '],
    ['--input', '--help'],
    ['--unknown'],
    ['--help', 'extra'],
    ['--input', 'a.json', 'b.json'],
  ]) {
    test(`rejects ambiguous arguments: ${JSON.stringify(args)}`, () => {
      expect(Result.isFailure(parseIntradayReplayCommandArgs(args))).toBe(true)
    })
  }

  test('help succeeds without archive, broker, or accounting configuration', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, `${import.meta.dir}/intraday-replay-command.ts`, '--help'],
      env: {},
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).trim()).toBe(INTRADAY_REPLAY_COMMAND_USAGE)
  })

  test('invalid arguments fail before input or configuration reads', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, `${import.meta.dir}/intraday-replay-command.ts`, '--input'],
      env: {},
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toContain(
      'IntradayReplayCommandArgumentError',
    )
  })

  test('invalid input JSON fails before archive configuration or reads', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, `${import.meta.dir}/intraday-replay-command.ts`, '--input', import.meta.path],
      env: {},
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toContain(
      'invalid replay input JSON',
    )
  })
})
