import { expect, test } from 'bun:test'
import { Effect, Redacted } from 'effect'
import { parseSessionReplayArgs, validateReplayDatabaseTargets } from './session-replay-command'
const config = {
  operationTimeoutMs: 1000,
  postgres: { url: Redacted.make('postgresql://test:test@127.0.0.1:55432/bayn_replay'), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 20912n, ledger: 70912, replicaAddresses: ['127.0.0.1:53000'] },
}
test('session command requires source, input and a separate output directory', () => {
  expect(parseSessionReplayArgs(['--help'])._tag).toBe('Help')
  expect(
    parseSessionReplayArgs(['--input', 'input.json', '--arrivals', 'raw.ndjson', '--output', 'result']),
  ).toMatchObject({ _tag: 'Run' })
  expect(parseSessionReplayArgs(['--input', 'input.json'])._tag).toBe('Invalid')
})
test('session command cannot target live database hosts or unspecified database names', async () => {
  expect((await Effect.runPromiseExit(validateReplayDatabaseTargets(config)))._tag).toBe('Success')
  for (const url of [
    'postgresql://test:test@bayn-rw.bayn.svc:5432/bayn_replay',
    'postgresql://test:test@127.0.0.1:55432/bayn',
    'https://localhost/bayn_replay',
  ])
    expect(
      (
        await Effect.runPromiseExit(
          validateReplayDatabaseTargets({ ...config, postgres: { ...config.postgres, url: Redacted.make(url) } }),
        )
      )._tag,
    ).toBe('Failure')
  expect(
    (
      await Effect.runPromiseExit(
        validateReplayDatabaseTargets({
          ...config,
          tigerBeetle: { ...config.tigerBeetle, replicaAddresses: ['tigerbeetle.bayn.svc:3000'] },
        }),
      )
    )._tag,
  ).toBe('Failure')
})
