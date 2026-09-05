import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { parseVendorReplayCommandArgs, VENDOR_INTRADAY_REPLAY_COMMAND_USAGE } from './vendor-intraday-replay-command'

test('requires explicit input and cache paths and preserves spaces', () => {
  expect(
    Result.getOrThrow(
      parseVendorReplayCommandArgs(['--input', '/tmp/research input.json', '--cache', '/tmp/market data']),
    ),
  ).toEqual({
    _tag: 'Run',
    inputPath: '/tmp/research input.json',
    cacheDirectory: '/tmp/market data',
  })
  for (const args of [
    [],
    ['--input', 'a.json'],
    ['--input', 'a.json', '--cache', ''],
    ['--input', '--help', '--cache', 'cache'],
    ['--help', 'extra'],
    ['--input', 'a', '--cache', 'b', 'extra'],
  ]) {
    expect(Result.isFailure(parseVendorReplayCommandArgs(args))).toBe(true)
  }
})

const invoke = (args: readonly string[]) =>
  Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/vendor-intraday-replay-command.ts`, ...args],
    env: {},
    stdout: 'pipe',
    stderr: 'pipe',
  })
const output = (result: ReturnType<typeof invoke>) =>
  new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)

test('help runs without credentials or cache access', () => {
  const result = invoke(['--help'])
  expect(result.exitCode).toBe(0)
  expect(new TextDecoder().decode(result.stdout).trim()).toBe(VENDOR_INTRADAY_REPLAY_COMMAND_USAGE)
})

test('invalid input and arguments fail before credentials or network reads', () => {
  const argumentsResult = invoke(['--input'])
  expect(argumentsResult.exitCode).toBe(1)
  expect(output(argumentsResult)).toContain('VendorReplayCommandArgumentError')
  const inputResult = invoke(['--input', import.meta.path, '--cache', '/unused-vendor-cache'])
  expect(inputResult.exitCode).toBe(1)
  expect(output(inputResult)).toContain('invalid vendor replay input JSON')
})
